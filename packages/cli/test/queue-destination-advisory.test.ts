import { describe, it, expect, vi } from "vitest";
import { createDaemon } from "../../daemon/src/startup.js";
import { queueCommand, type QueueDeps } from "../src/commands/queue.js";

describe("queue destination advisory through CLI and route", () => {
  it("prints the accepted typo unchanged for create and both handoffs", async () => {
    const saved = { noKernel: process.env.OPENRIG_NO_KERNEL, session: process.env.OPENRIG_SESSION_NAME };
    process.env.OPENRIG_NO_KERNEL = "1";
    process.env.OPENRIG_SESSION_NAME = "sender-ba@advisory-source";
    const daemon = await createDaemon({ cmuxFactory: async () => {
      throw Object.assign(new Error("no fixture socket"), { code: "ENOENT" });
    }, tmuxExec: async () => "" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const source = daemon.deps.rigRepo.createRig("advisory-source");
      daemon.deps.rigRepo.addNode(source.id, "sender.ba", { runtime: null });
      const target = daemon.deps.rigRepo.createRig("advisory-target");
      daemon.deps.rigRepo.addNode(target.id, "product.ba", { runtime: null });
      daemon.deps.rigRepo.addNode(target.id, "finance.cfo", { runtime: null });
      const client = { post: async (url: string, body: unknown) => {
        const response = await daemon.app.request(url, { method: "POST", headers: {
          "Content-Type": "application/json", "X-OpenRig-Session": "sender-ba@advisory-source",
        }, body: JSON.stringify(body) });
        return { status: response.status, data: await response.json() };
      } };
      const deps: QueueDeps = {
        lifecycleDeps: { readFile: () => null, exists: () => false,
          fetch: async () => ({ ok: true }) } as QueueDeps["lifecycleDeps"],
        clientFactory: () => client as unknown as ReturnType<QueueDeps["clientFactory"]>,
      };
      for (const json of [false, true]) {
        for (const verb of ["create", "handoff", "handoff-and-complete"]) {
          const original = await daemon.deps.queueRepo.create({ sourceSession: "sender-ba@advisory-source",
            destinationSession: "sender-ba@advisory-source", body: "fixture source", nudge: false });
          const args = verb === "create"
            ? [verb, "--destination", "prodcut-ba@advisory-target", "--body", "fixture", "--summary", "fixture"]
            : [verb, original.qitemId, "--to", "prodcut-ba@advisory-target"];
          log.mockClear(); warn.mockClear();
          await queueCommand(deps).parseAsync([...args, "--no-nudge", ...(json ? ["--json"] : [])], { from: "user" });
          expect(warn.mock.calls.map((call) => call.join(" ")).join("\n")).toMatch(/^Warning: Suspected seat typo: 'prodcut-ba@advisory-target'/m);
          const result = JSON.parse(log.mock.calls.map(call => call.join(" ")).join("\n"));
          expect(result.advisories[0].code).toBe("unmatched_destination_seat");
          expect(result.advisories[0].availableDestinations).toEqual(["finance-cfo@advisory-target", "product-ba@advisory-target"]);
          expect(result.advisories[0].message).toContain("does not guarantee pickup or delivery");
          const row = result.created ?? result;
          expect(row.destinationSession).toBe("prodcut-ba@advisory-target");
          expect(daemon.deps.queueRepo.getById(row.qitemId)?.destinationSession).toBe(row.destinationSession);
        }
      }
      warn.mockClear();
      await queueCommand(deps).parseAsync(["create", "--destination", "cfo@advisory-target", "--body", "fixture", "--summary", "fixture", "--no-nudge"], { from: "user" });
      expect(warn.mock.calls.map((call) => call.join(" ")).join("\n")).toContain("Did you mean finance-cfo@advisory-target?");
    } finally {
      log.mockRestore();
      warn.mockRestore();
      daemon.eventLoopMonitor.stop(); daemon.contextMonitor.stop(); daemon.deps.seatActivityService?.stop();
      daemon.db.close();
      if (saved.noKernel === undefined) delete process.env.OPENRIG_NO_KERNEL;
      else process.env.OPENRIG_NO_KERNEL = saved.noKernel;
      if (saved.session === undefined) delete process.env.OPENRIG_SESSION_NAME;
      else process.env.OPENRIG_SESSION_NAME = saved.session;
    }
  }, 30_000);
});
