// Send an email from Slack: the daemon stores the exact payload under its digest, only the card's human can answer,
// Send sends exactly that payload once, and auto-send runs only under enabled rules within a reserved daily cap.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { queueRoutes } from "../src/routes/queue.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { actOnSendAnswers, gwsSender, gwsLookup, cardFields, sha256, buildMessage, digestOf, normalizeAddress, parseRules, reserveSlot, ruleMatches, buildPayload, type SendResult, type AutoSendRule } from "../src/domain/human-send.js";

const human = "human-founder@external";
const seat = "outbox-sender@inbox";
const registry = { ok: true as const, entities: [{ entityId: "human-founder", class: "human" as const, displayName: "Founder", address: human, connectorBindings: [{ kind: "slack" as const, connectorRef: "primary", secretsRef: "env:SLACK_BOT_TOKEN", role: "primary" as const, handle: "UFOUNDER" }], prefs: { deliveryClass: "A" as const } }] };
const pretty = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
const email = { to: ["Pat@Example.com"], cc: ["ops@example.com"], bcc: ["audit@example.org"], subject: "Invoice 12", text: "Hello Pat,\nthe invoice is attached.\n" };

describe("send an email from Slack", () => {
  let db: ReturnType<typeof createDb>;
  let repo: QueueRepository;
  let app: Hono;
  let home: string;
  let paths: { storeDir: string; rulesPath: string };
  let sent: string[];
  let threads: Array<string | undefined>;
  let results: SendResult[];
  let clock: number;
  const send = async (path: string, threadId?: string): Promise<SendResult> => { sent.push(readFileSync(path, "utf8")); threads.push(threadId); return results.shift() ?? { status: "sent", id: `m${sent.length}` }; };

  beforeEach(() => {
    db = createDb(); migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { loadHumanRegistry: () => registry });
    home = realpathSync(mkdtempSync(join(tmpdir(), "human-send-")));
    paths = { storeDir: join(home, "payloads"), rulesPath: join(home, "auto-send-rules.json") };
    sent = []; threads = []; results = []; clock = Date.now();
    app = new Hono();
    app.use("*", async (c, next) => { const set = c.set as (k: string, v: unknown) => void; set("queueRepo", repo); set("humanSendPaths", paths); await next(); });
    app.route("/api/queue", queueRoutes());
  });
  afterEach(() => { db.close(); rmSync(home, { recursive: true, force: true }); });

  const post = (body: Record<string, unknown>, from = seat) => app.request("/api/queue/create", { method: "POST",
    headers: { "Content-Type": "application/json", "X-OpenRig-Session": from }, body: JSON.stringify({ destinationSession: human, nudge: false, ...body }) });
  const ask = async (payload: Record<string, unknown> = email, from = seat) => { const res = await post({ humanSend: payload }, from); expect(res.status).toBe(201); return (await res.json()) as { qitemId: string; tags: string[]; humanIntent: string } };
  const forge = (id: string, transitionNote: string) => app.request(`/api/queue/${id}/update`, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ actorSession: "daemon@kernel", transitionNote }) });
  const click = (id: string, actor: string, option: string, question = "send") => repo.recordHumanAnswer({ qitemId: id, actorSession: actor, questionId: question, optionId: option });
  const act = (approver: string | null = human) => actOnSendAnswers(repo, { send, approver: () => approver, ...paths, now: () => clock });
  const thread = (id: string) => repo.list({ limit: 200 }).filter((q) => q.replyTo === id).map((q) => q.body).join("\n");
  const toSeat = (from = seat) => repo.list({ limit: 200 }).filter((q) => q.destinationSession === from).map((q) => q.body).join("\n");
  const markPosted = (id: string) => {
    const owner = repo.transitionLog.latestOwnerNotificationForQitem(id)!;
    repo.update({ qitemId: id, actorSession: "daemon@kernel", transitionNote: `slack-owner-notification-posted notification_key=${id}:${owner.transitionId}` });
  };
  const enableRules = async (rules: unknown) => {
    writeFileSync(paths.rulesPath, pretty(rules));
    const res = await post({ humanSendRules: true });
    expect(res.status).toBe(201);
    const id = (await res.json()).qitemId as string;
    click(id, human, "enable", "rules");
    await act();
    return id;
  };
  const rule = (extra: Record<string, unknown> = {}) => ({ id: "billing", recipientWhitelist: [{ domain: "example.com" }, { address: "audit@example.org" }], ...extra });

  it("builds a Send / Edit / Skip card for the human with the exact text in its thread and the payload digest", async () => {
    const card = await ask();
    const row = repo.getById(card.qitemId)!;
    expect(row.humanIntent).toBe("decision");
    expect(row.humanQuestions?.[0]!.options.map((o) => o.label)).toEqual(["Send", "Edit", "Skip"]);
    expect(row.summary).toBe("Send email to pat@example.com +2: Invoice 12");
    expect(row.body).toBe("Email to pat@example.com and 2 more.\nEvery recipient, the exact text and its digest are in this thread.\nSend sends exactly that once; Edit or Skip sends nothing.");
    expect(row.humanDetail).toBe(["To: pat@example.com", "Cc: ops@example.com", "Bcc: audit@example.org", "Subject: Invoice 12",
      `Payload sha256: ${digestOf(buildPayload(email))}`, "Text, exactly as it will be sent:", email.text].join("\n"));
  });

  it("every root (send card, auto-send report, rules card) is at most three short plain lines with no header, digest or path", async () => {
    const roots = [repo.getById((await ask()).qitemId)!];
    writeFileSync(paths.rulesPath, pretty({ version: 1, enabled: true, rules: [rule()] }));
    const rulesCard = (await (await post({ humanSendRules: true })).json()).qitemId as string;
    roots.push(repo.getById(rulesCard)!);
    expect(repo.getById(rulesCard)!.humanDetail).toContain(sha256(readFileSync(paths.rulesPath, "utf8")));
    expect(repo.getById(rulesCard)!.humanDetail).toContain(paths.rulesPath);
    click(rulesCard, human, "enable", "rules");
    await act();
    roots.push(repo.getById((await ask({ ...email, subject: "Auto" })).qitemId)!);
    expect(roots[2]!.tags).toContain("human-send-auto");
    for (const row of roots) {
      const lines = row.body.split("\n");
      expect(lines.length).toBeLessThanOrEqual(3);
      for (const line of lines) {
        expect(line.length).toBeLessThanOrEqual(90);
        expect(line).not.toMatch(/^[*#>]|`|[0-9a-f]{12}|\/|sha256/);
      }
    }
  });

  it("refuses display names, lists, header breaks and duplicates before any card exists", async () => {
    for (const bad of [{ ...email, to: ["Pat <pat@example.com>"] }, { ...email, to: ["a@example.com, b@example.com"] }, { ...email, cc: ["x@example.com\r\nBcc: evil@x.com"] },
      { ...email, subject: "Hi\r\nBcc: evil@x.com" }, { ...email, to: [] }, { ...email, cc: ["pat@example.com"] }, { ...email, channel: "imessage" }]) {
      expect((await post({ humanSend: bad })).status).toBe(400);
    }
    expect(repo.list({ limit: 50 })).toEqual([]);
  });

  it("Send from the card's human sends exactly the stored payload once", async () => {
    const card = await ask();
    click(card.qitemId, human, "send");
    await act();
    expect(sent).toEqual([buildMessage(buildPayload(email))]);
    expect(sent[0]).toContain("To: pat@example.com");
    expect(sent[0]).toContain("Cc: ops@example.com");
    expect(sent[0]).toContain("Bcc: audit@example.org");
    expect(thread(card.qitemId)).toContain("Gmail id `m1`");
    expect(toSeat()).toContain("sent (Gmail id m1)");
    await act();
    expect(sent).toHaveLength(1);
  });

  it("another user's click, a card for another human, a typed reply, Edit and Skip send nothing", async () => {
    const stranger = await ask();
    expect(click(stranger.qitemId, "someone@external", "send")).toMatchObject({ status: "not-applicable" });
    const otherHuman = await ask();
    click(otherHuman.qitemId, human, "send");
    await act("other-human@external");
    expect(sent).toEqual([]);
    expect(thread(otherHuman.qitemId)).toContain("only other-human@external can approve sends");
    const typed = await ask();
    repo.resolveDirectHumanReply({ qitemId: typed.qitemId, actorSession: human, decision: "send" });
    const edit = await ask();
    click(edit.qitemId, human, "edit");
    const skip = await ask();
    click(skip.qitemId, human, "skip");
    await act();
    expect(sent).toEqual([]);
    expect(thread(edit.qitemId)).toContain("Edit asks the seat for a new version");
    expect(thread(skip.qitemId)).toContain("Skipped: nothing was sent.");
    expect(toSeat()).toContain("submit the revised payload as a new --human-send card");
  });

  it("a payload changed after the card was built is refused", async () => {
    const card = await ask();
    const file = join(paths.storeDir, `${digestOf(buildPayload(email))}.json`);
    chmodSync(file, 0o600);
    writeFileSync(file, readFileSync(file, "utf8").replace("pat@example.com", "evil@attacker.test"));
    click(card.qitemId, human, "send");
    await act();
    expect(sent).toEqual([]);
    expect(thread(card.qitemId)).toContain("stored payload is missing or no longer matches");
  });

  it("an id the seat already used for its own row never becomes a card, so its button labels cannot be swapped", async () => {
    const fields = cardFields(buildPayload(email), digestOf(buildPayload(email)));
    const swapped = [{ id: "send", question: "Send?", options: [{ id: "send", label: "Skip" }, { id: "skip", label: "Send" }] }];
    const res = await post({ qitemId: "qitem-20261027000000-aaaaaaaaaaaaaaaa", ...fields, tags: ["human-send"], humanQuestions: swapped });
    expect(res.status).toBe(201);
    expect((await post({ qitemId: "qitem-20261027000000-aaaaaaaaaaaaaaaa", humanSend: email })).status).toBe(409);
    const retry = await ask();
    expect((await post({ qitemId: retry.qitemId, humanSend: email })).status).toBe(201);
    expect(repo.list({ limit: 50 }).filter((q) => q.tags?.includes("human-send"))).toHaveLength(2);
  });

  it("a seat-written row that looks like a card is never sent", async () => {
    const res = await post({ body: "fake", summary: "fake", tags: ["human-send"], humanQuestions: [{ id: "send", question: "Send?", options: [{ id: "send", label: "Send" }, { id: "skip", label: "Skip" }] }] });
    expect(res.status, await res.clone().text()).toBe(201);
    const id = (await res.json()).qitemId as string;
    expect((await forge(id, `human-send card: ${digestOf(buildPayload(email))}`)).status).toBe(200);
    expect(repo.transitionLog.listForQitem(id).some((t) => t.actorSession === "daemon@kernel" && t.identityProvenance !== null)).toBe(true);
    click(id, human, "send");
    await act();
    expect(sent).toEqual([]);
  });

  it("an unknown delivery is reported and never retried; a send interrupted by a stop reads unknown", async () => {
    results = [{ status: "unknown", detail: "gws timed out" }];
    const card = await ask();
    click(card.qitemId, human, "send");
    await act();
    await act();
    expect(sent).toHaveLength(1);
    expect(thread(card.qitemId)).toContain("Delivery unknown: gws timed out. It is not retried");
    const second = await ask({ ...email, subject: "Second" });
    click(second.qitemId, human, "send");
    repo.update({ qitemId: second.qitemId, actorSession: "daemon@kernel", transitionNote: "human-send result: send pending" });
    await act();
    expect(sent).toHaveLength(1);
    expect(thread(second.qitemId)).toContain("the daemon stopped during the send");
  });

  it("the message keeps every recipient header and attachment bytes; nothing reaches the sender's arguments", async () => {
    const file = join(home, "invoice.pdf");
    writeFileSync(file, Buffer.from("%PDF-1.4 test"));
    const card = await ask({ ...email, attachments: [file] });
    expect(repo.getById(card.qitemId)!.body).toContain("1 attachment.");
    expect(repo.getById(card.qitemId)!.humanDetail).toContain(`Attachment: invoice.pdf (application/pdf, sha256 ${createHash("sha256").update("%PDF-1.4 test").digest("hex")})`);
    writeFileSync(file, Buffer.from("changed after the card"));
    click(card.qitemId, human, "send");
    await act();
    expect(sent[0]).toContain(Buffer.from("%PDF-1.4 test").toString("base64"));
    expect(sent[0]).toContain('filename="invoice.pdf"');
    expect(readdirSync(join(paths.storeDir, "outgoing"))).toEqual([]);
  });

  it("the gws sender passes only the message file, relative to its folder; a 4xx is failed, anything else unknown", async () => {
    const bin = join(home, "bin");
    const log = join(home, "gws.log");
    const fake = (body: string) => { writeFileSync(join(bin, "gws"), `#!/bin/sh\necho "$PWD $*" >> ${log}\n${body}\n`); chmodSync(join(bin, "gws"), 0o755); };
    const message = join(home, "out", "d.eml");
    mkdirSync(join(home, "out")); mkdirSync(bin);
    writeFileSync(message, buildMessage(buildPayload(email)));
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      fake(`echo '{"id":"g1","labelIds":["SENT"]}'`);
      expect(await gwsSender(message)).toEqual({ status: "sent", id: "g1" });
      fake(`echo '{"error":{"code":400,"message":"Invalid To header"}}'; exit 1`);
      expect(await gwsSender(message)).toMatchObject({ status: "failed" });
      fake("exit 1");
      expect(await gwsSender(message)).toMatchObject({ status: "unknown" });
      fake(`echo '{}'`);
      expect(await gwsSender(message)).toMatchObject({ status: "unknown" });
      fake(`echo '{"id":"g2","threadId":"1a15a2e4aeb6fdcc"}'`);
      expect(await gwsSender(message, "1a15a2e4aeb6fdcc")).toEqual({ status: "sent", id: "g2" });
    } finally {
      process.env.PATH = path;
    }
    const calls = readFileSync(log, "utf8").trim().split("\n");
    expect(calls[0]).toBe(`${join(home, "out")} gmail users messages send --params {"userId":"me"} --upload d.eml --upload-content-type message/rfc822`);
    expect(calls[4]).toBe(`${join(home, "out")} gmail users messages send --params {"userId":"me"} --json {"threadId":"1a15a2e4aeb6fdcc"} --upload d.eml --upload-content-type message/rfc822`);
    expect(calls.join("\n")).not.toContain("example.com");
  });

  it("the gws lookup reads only the original's metadata and its headers whatever their case", async () => {
    const bin = join(home, "bin");
    const log = join(home, "gws.log");
    mkdirSync(bin);
    writeFileSync(join(bin, "gws"), `#!/bin/sh\necho "$*" >> ${log}\necho '{"id":"1a169783c408881c","threadId":"1a15a2e4aeb6fdcc","payload":{"headers":[{"name":"Subject","value":"Hi"},{"name":"Message-Id","value":"<a.1@x.example>"},{"name":"REFERENCES","value":"<z.0@x.example>"}]}}'\n`);
    chmodSync(join(bin, "gws"), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      expect(await gwsLookup("1a169783c408881c")).toEqual({ id: "1a169783c408881c", threadId: "1a15a2e4aeb6fdcc", messageId: "<a.1@x.example>", references: "<z.0@x.example>", subject: "Hi" });
    } finally {
      process.env.PATH = path;
    }
    expect(readFileSync(log, "utf8").trim()).toBe('gmail users messages get --params {"userId":"me","id":"1a169783c408881c","format":"metadata","metadataHeaders":["Message-ID","References","Subject"]}');
  });

  describe("a reply in an existing Gmail thread", () => {
    const original = { id: "1a169783c408881c", threadId: "1a15a2e4aeb6fdcc", messageId: "<CAOrig.42@mail.example.com>",
      references: "<CAFirst.1@mail.example.com>\r\n <CAOrig.42@mail.example.com>", subject: "NY collection case – missed RFI" };
    let lookups: string[];
    let found: Record<string, unknown> | null;
    const reply = { ...email, subject: undefined, replyToGmailId: original.id, threadId: original.threadId };
    beforeEach(() => {
      lookups = []; found = original;
      app = new Hono();
      app.use("*", async (c, next) => { const set = c.set as (k: string, v: unknown) => void; set("queueRepo", repo); set("humanSendPaths", paths);
        set("humanSendLookup", async (id: string) => { lookups.push(id); if (!found) throw new Error("Requested entity was not found"); return found; }); await next(); });
      app.route("/api/queue", queueRoutes());
    });

    it("the daemon reads the original by its Gmail id and binds thread, In-Reply-To and References into the payload the card approves", async () => {
      const card = await ask(reply);
      expect(lookups).toEqual([original.id]);
      const payload = JSON.parse(readdirSync(paths.storeDir).map((f) => readFileSync(join(paths.storeDir, f), "utf8"))[0]!);
      expect(payload.subject).toBe("Re: NY collection case – missed RFI");
      expect(payload.reply).toEqual({ gmailId: original.id, threadId: original.threadId, inReplyTo: "<CAOrig.42@mail.example.com>",
        references: ["<CAFirst.1@mail.example.com>", "<CAOrig.42@mail.example.com>"] });
      const row = repo.getById(card.qitemId)!;
      expect(row.summary).toBe("Send reply to pat@example.com +2: Re: NY collection case – missed RFI");
      expect(row.humanDetail).toContain(`Reply in Gmail thread ${original.threadId} to Gmail message ${original.id} (In-Reply-To <CAOrig.42@mail.example.com>)`);
    });

    it("Send sends the threaded message with the thread id beside it, never a new standalone email", async () => {
      const card = await ask(reply);
      click(card.qitemId, human, "send");
      await act();
      expect(threads).toEqual([original.threadId]);
      expect(sent[0]).toContain("\r\nIn-Reply-To: <CAOrig.42@mail.example.com>\r\nReferences: <CAFirst.1@mail.example.com>\r\n <CAOrig.42@mail.example.com>\r\n");
      expect(sent[0]).toContain(`Subject: =?UTF-8?B?${Buffer.from("Re: NY collection case – missed RFI").toString("base64")}?=`);
    });

    it("a plain email keeps its digest and sends with no thread id", async () => {
      const plain = buildPayload(email);
      const { channel, to, cc, bcc, subject, text, attachments } = plain;
      expect(digestOf(plain)).toBe(sha256(JSON.stringify({ channel, to, cc, bcc, subject, text, attachments })));
      click((await ask()).qitemId, human, "send");
      await act();
      expect(threads).toEqual([undefined]);
      expect(sent[0]).not.toContain("In-Reply-To");
    });

    it("the digest covers the thread binding: a stored reply moved to another thread is refused", async () => {
      const card = await ask(reply);
      const file = join(paths.storeDir, readdirSync(paths.storeDir)[0]!);
      chmodSync(file, 0o600);
      writeFileSync(file, readFileSync(file, "utf8").replace(original.threadId, "1a15a2e4aeb6ffff"));
      click(card.qitemId, human, "send");
      await act();
      expect(sent).toEqual([]);
      expect(thread(card.qitemId)).toContain("stored payload is missing or no longer matches");
    });

    it("refuses an RFC Message-ID given as the Gmail id, a thread that is not the message's, a changed subject and an unreadable original", async () => {
      const refusal = async (payload: Record<string, unknown>) => { const res = await post({ humanSend: payload }); expect(res.status).toBe(400); return (await res.json()).error as string; };
      expect(await refusal({ ...reply, replyToGmailId: original.messageId })).toMatch(/Gmail id .* not the RFC Message-ID/);
      expect(await refusal({ ...reply, threadId: "1a15a2e4aeb6ffff" })).toMatch(/is in thread 1a15a2e4aeb6fdcc, not 1a15a2e4aeb6ffff/);
      expect(await refusal({ ...reply, subject: "Something else" })).toMatch(/keep the thread's subject/);
      expect(await refusal({ ...email, threadId: original.threadId })).toMatch(/threadId needs replyToGmailId/);
      found = { ...original, messageId: "<a@b>\r\nBcc: evil@attacker.test" };
      expect(await refusal(reply)).toMatch(/no usable Message-ID/);
      found = { ...original, id: "1a169783c408ffff" };
      expect(await refusal(reply)).toMatch(/different message/);
      found = null;
      expect(await refusal(reply)).toMatch(/could not read Gmail message 1a169783c408881c: Requested entity was not found/);
      expect(repo.list({ limit: 50 })).toEqual([]);
    });

    it("a subject that keeps the thread's subject is kept as written; injected References entries are dropped", async () => {
      found = { ...original, references: "<ok.1@x.example> <bad\r\nBcc: evil@attacker.test> junk <CAOrig.42@mail.example.com>" };
      await ask({ ...reply, subject: "RE: NY collection case – missed RFI" });
      const payload = JSON.parse(readFileSync(join(paths.storeDir, readdirSync(paths.storeDir)[0]!), "utf8"));
      expect(payload.subject).toBe("RE: NY collection case – missed RFI");
      expect(payload.reply.references).toEqual(["<ok.1@x.example>", "<CAOrig.42@mail.example.com>"]);
    });
  });

  describe("auto-send rules", () => {
    it("parse like the schema: recipient constraints required, cap 1..20 (default 20), unknown keys refused", () => {
      expect(parseRules(pretty({ version: 1, enabled: false, rules: [] }))).toEqual({ enabled: false, rules: [] });
      expect(parseRules(pretty({ version: 1, enabled: true, rules: [rule()] })).rules[0]!.dailyCap).toBe(20);
      for (const bad of [{ id: "a" }, { id: "a", recipientWhitelist: [] }, { ...rule(), dailyCap: 21 }, { ...rule(), dailyCap: 0 }, { ...rule(), extra: 1 },
        { id: "a", recipient: { address: "x@example.com", domain: "example.com" } }, { id: "a", recipient: { domain: "*.example.com" } }]) {
        expect(() => parseRules(pretty({ version: 1, enabled: true, rules: [bad] }))).toThrow();
      }
    });

    it("every recipient including cc and bcc must match; domains match exactly, never by suffix or substring", () => {
      const p = (to: string[], cc: string[] = [], bcc: string[] = []) => buildPayload({ to, cc, bcc, subject: "s", text: "t" });
      const r = parseRules(pretty({ version: 1, enabled: true, rules: [{ id: "d", recipientWhitelist: [{ domain: "nex9.com" }] }] })).rules[0]!;
      expect(ruleMatches(r, seat, p(["a@nex9.com"], ["B@NEX9.com"]))).toBe(true);
      for (const evil of ["a@evil-nex9.com", "a@nex9.com.evil.test", "a@sub.nex9.com", "nex9.com@evil.test", "a@nex9.co"]) {
        expect(ruleMatches(r, seat, p([evil]))).toBe(false);
        expect(ruleMatches(r, seat, p(["a@nex9.com"], [evil]))).toBe(false);
        expect(ruleMatches(r, seat, p(["a@nex9.com"], [], [evil]))).toBe(false);
      }
      expect(normalizeAddress(" Reco@Nex9.com ")).toBe("reco@nex9.com");
    });

    it("seat and channel restrictions and both recipient constraints are ANDed", () => {
      const p = buildPayload({ to: ["reco@nex9.com"], subject: "s", text: "t" });
      const both = parseRules(pretty({ version: 1, enabled: true, rules: [{ id: "x", seat, channel: "email", recipient: { domain: "nex9.com" }, recipientWhitelist: [{ address: "reco@nex9.com" }] }] })).rules[0]!;
      expect(ruleMatches(both, seat, p)).toBe(true);
      expect(ruleMatches(both, "other@rig", p)).toBe(false);
      expect(ruleMatches({ ...both, channel: "imessage" }, seat, p)).toBe(false);
      expect(ruleMatches({ ...both, recipientWhitelist: [{ address: "pat@nex9.com" }] }, seat, p)).toBe(false);
    });

    it("start disabled: an empty or disabled rules file, or no file, always builds a card", async () => {
      expect((await ask()).humanIntent).toBe("decision");
      await enableRules({ version: 1, enabled: false, rules: [rule()] });
      expect((await ask()).humanIntent).toBe("decision");
    });

    it("a rules file the human did not enable, or changed after enabling, never auto-sends", async () => {
      writeFileSync(paths.rulesPath, pretty({ version: 1, enabled: true, rules: [rule()] }));
      expect((await ask()).tags).toContain("human-send");
      await enableRules({ version: 1, enabled: true, rules: [rule()] });
      expect((await ask()).tags).toContain("human-send-auto");
      writeFileSync(paths.rulesPath, pretty({ version: 1, enabled: true, rules: [rule({ recipientWhitelist: [{ domain: "attacker.test" }] })] }));
      expect((await ask({ ...email, to: ["x@attacker.test"], cc: [], bcc: [] })).tags).toContain("human-send");
      expect((await ask()).tags).toContain("human-send");
    });

    it("a rules decision from a seat-written note or another user's click enables nothing", async () => {
      writeFileSync(paths.rulesPath, pretty({ version: 1, enabled: true, rules: [rule()] }));
      const res = await post({ humanSendRules: true });
      const id = (await res.json()).qitemId as string;
      expect(click(id, "someone@external", "enable", "rules")).toMatchObject({ status: "not-applicable" });
      expect((await forge(id, `human-send rules enabled ${sha256(readFileSync(paths.rulesPath, "utf8"))}`)).status).toBe(200);
      await act();
      expect((await ask()).tags).toContain("human-send");
    });

    it("an auto-send waits for its Slack report to post, then sends once and reports the result in that thread", async () => {
      await enableRules({ version: 1, enabled: true, rules: [rule()] });
      const auto = await ask();
      expect(auto.humanIntent).toBe("update");
      await act();
      expect(sent).toEqual([]);
      markPosted(auto.qitemId);
      await act();
      await act();
      expect(sent).toHaveLength(1);
      expect(thread(auto.qitemId)).toContain("Rule `billing`");
    });

    it("an auto-send whose report never posts is held before sending", async () => {
      await enableRules({ version: 1, enabled: true, rules: [rule()] });
      const auto = await ask();
      clock += 11 * 60_000;
      await act();
      markPosted(auto.qitemId);
      await act();
      expect(sent).toEqual([]);
      expect(toSeat()).toContain("held before sending: its Slack report was not posted");
    });

    it("rules changed between queueing and sending hold the auto-send", async () => {
      await enableRules({ version: 1, enabled: true, rules: [rule()] });
      const auto = await ask();
      writeFileSync(paths.rulesPath, pretty({ version: 1, enabled: true, rules: [rule({ dailyCap: 5 })] }));
      markPosted(auto.qitemId);
      await act();
      expect(sent).toEqual([]);
      expect(thread(auto.qitemId)).toContain("Held: the rules file is not the version the human enabled");
    });

    it("a seat-written Slack receipt does not count as the report having posted", async () => {
      await enableRules({ version: 1, enabled: true, rules: [rule()] });
      const auto = await ask();
      const owner = repo.transitionLog.latestOwnerNotificationForQitem(auto.qitemId)!;
      expect((await forge(auto.qitemId, `slack-owner-notification-posted notification_key=${auto.qitemId}:${owner.transitionId}`)).status).toBe(200);
      await act();
      expect(sent).toEqual([]);
    });

    it("a rules file with duplicate keys, compact formatting or a backtick id is refused before any card", async () => {
      const text = pretty({ version: 1, enabled: true, rules: [{ id: "r", recipient: { address: "boss@corp.com" } }] });
      for (const bad of [text.replace('"address": "boss@corp.com"', '"address": "boss@corp.com", "domain": "gmail.com"'), text.replace('"enabled": true', '"enabled": false,\n  "enabled": true'),
        JSON.stringify(JSON.parse(text)), pretty({ version: 1, enabled: true, rules: [{ id: "a`b", recipient: { address: "boss@corp.com" } }] })]) {
        writeFileSync(paths.rulesPath, bad);
        expect((await post({ humanSendRules: true })).status).toBe(400);
      }
    });

    it("Enable on one rules card and Reject on another in the same pass leaves auto-send off", async () => {
      writeFileSync(paths.rulesPath, pretty({ version: 1, enabled: true, rules: [rule()] }));
      const a = (await (await post({ humanSendRules: true })).json()).qitemId as string;
      const b = (await (await post({ humanSendRules: true })).json()).qitemId as string;
      click(b, human, "enable", "rules");
      click(a, human, "reject", "rules");
      await act();
      expect((await ask()).tags).toContain("human-send");
    });

    it("ambiguous matches build a card", async () => {
      await enableRules({ version: 1, enabled: true, rules: [rule(), rule({ id: "second" })] });
      expect((await ask()).tags).toContain("human-send");
    });

    it("cap 20: the 20th auto-send of the day sends, the 21st is held; the next New York day has a fresh cap", async () => {
      await enableRules({ version: 1, enabled: true, rules: [rule()] });
      const ids: string[] = [];
      for (let i = 0; i < 21; i++) ids.push((await ask({ ...email, subject: `Invoice ${i}` })).qitemId);
      ids.forEach(markPosted);
      await act();
      expect(sent).toHaveLength(20);
      expect(thread(ids[20]!)).toContain("already used its 20 sends today");
      clock += 24 * 3600_000;
      const next = (await ask({ ...email, subject: "Next day" })).qitemId;
      markPosted(next);
      await act();
      expect(sent).toHaveLength(21);
    });

    it("an unknown or failed auto-send still consumes its slot", async () => {
      await enableRules({ version: 1, enabled: true, rules: [rule({ dailyCap: 1 })] });
      results = [{ status: "unknown", detail: "gws timed out" }];
      const a = (await ask()).qitemId;
      const b = (await ask({ ...email, subject: "b" })).qitemId;
      markPosted(a); markPosted(b);
      await act();
      expect(sent).toHaveLength(1);
      expect(thread(b)).toContain("already used its 1 sends today");
    });

    it("reservations from two connections to the same database share one count, and are idempotent per row", () => {
      const file = join(home, "q.sqlite");
      const one = createDb(file); migrate(one, ALL_MIGRATIONS);
      const two = createDb(file);
      const r1 = new QueueRepository(one, new EventBus(one), { loadHumanRegistry: () => registry });
      const r2 = new QueueRepository(two, new EventBus(two), { loadHumanRegistry: () => registry });
      const capped: AutoSendRule = { id: "c", recipientWhitelist: [{ domain: "example.com" }], dailyCap: 3 };
      const rows = Array.from({ length: 6 }, (_, i) => one.prepare("INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, body) VALUES (?, ?, ?, ?, ?, 'pending', 'routine', 'x')")
        .run(`q${i}`, new Date(clock).toISOString(), new Date(clock).toISOString(), seat, human) && `q${i}`);
      const granted = rows.map((id, i) => reserveSlot(i % 2 ? r2 : r1, id as string, capped, clock));
      expect(granted.filter(Boolean)).toHaveLength(3);
      expect(reserveSlot(r2, "q0", capped, clock)).toBe(true);
      one.close(); two.close();
    });
  });
});
