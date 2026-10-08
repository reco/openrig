// A Codex update on disk under a running seat is a health finding with a same-conversation restart.
import { afterEach, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { HealthProjectionService, RuntimeBinaryHealthSource } from "../src/domain/health-detectors.js";
import { HealthPolicyStore } from "../src/domain/health-policy.js";
import { delegatedPostureFixture } from "./helpers/delegated-posture.js";
import { computerUseHelperBinaries, recordLaunchFingerprint } from "../src/domain/runtime-binary-fingerprint.js";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).reverse().forEach((f) => f()));

it("finds a Codex binary changed since this occupant launched, with a same-conversation restart; unchanged or older records are quiet", () => {
  const home = mkdtempSync(join(tmpdir(), "binary-drift-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const db = createDb(); migrate(db, ALL_MIGRATIONS); cleanups.push(() => db.close());
  const rigs = new RigRepository(db); const sessions = new SessionRegistry(db);
  const rig = rigs.createRig("psa");
  const node = rigs.addNode(rig.id, "psa-dev", { role: "worker" });
  const session = sessions.registerSession(node.id, "psa-dev@psa");
  sessions.updateStatus(session.id, "running");
  db.prepare("UPDATE sessions SET resume_type = 'codex_id', resume_token = 'thread-123' WHERE id = ?").run(session.id);
  const codex = join(home, "codex");
  writeFileSync(codex, "#!/bin/sh\necho v1\n");
  recordLaunchFingerprint(home, node.id, "psa-dev@psa", [{ label: "Codex", file: codex }]);
  const source = new RuntimeBinaryHealthSource({ home, rigRepo: rigs, sessionRegistry: sessions });
  expect(source.read()).toEqual([]);

  writeFileSync(codex, "#!/bin/sh\necho v2 with a longer body\n");
  utimesSync(codex, new Date(), new Date(Date.now() + 5000));
  const [finding] = source.read();
  expect(finding).toMatchObject({ kind: "runtime-binary-drift", runtime: "Codex", sessionName: "psa-dev@psa", binary: codex, restartCommand: "rig seat handover psa-dev@psa --source fork:thread-123 --reason codex-updated" });
  const policy = new HealthPolicyStore(home, () => ({ warningPercent: 95, criticalPercent: 99 }));
  const [record] = new HealthProjectionService(source, () => policy.read(), delegatedPostureFixture).list().records;
  expect(record).toMatchObject({ detector: "runtime.binary-drift", severity: "warning" });
  expect(JSON.stringify(record)).toContain("rig seat handover psa-dev@psa --source fork:thread-123 --reason codex-updated");

  recordLaunchFingerprint(home, node.id, "psa-dev@psa", [{ label: "Codex", file: codex }], new Date(Date.now() - 24 * 3600_000));
  writeFileSync(codex, "#!/bin/sh\necho v3 from an older launch record\n");
  expect(source.read()).toEqual([]);
});

it("finds a computer-use helper update for a seat whose Codex config enables the plugin", () => {
  const config = '[plugins."computer-use@openai-bundled"]\nenabled = true\n\n[x]\nSKY_CUA_SERVICE_PATH = "/Apps/Codex Computer Use.app"\n';
  expect(computerUseHelperBinaries(config, "/home/u").map((b) => b.file)).toEqual([
    "/Apps/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService",
    "/Apps/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient",
  ]);
  expect(computerUseHelperBinaries('[plugins."computer-use@openai-bundled"]\nenabled = false\n', "/home/u")).toEqual([]);

  const home = mkdtempSync(join(tmpdir(), "cua-drift-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const db = createDb(); migrate(db, ALL_MIGRATIONS); cleanups.push(() => db.close());
  const rigs = new RigRepository(db); const sessions = new SessionRegistry(db);
  const rig = rigs.createRig("ops");
  const node = rigs.addNode(rig.id, "cu", { role: "worker" });
  const session = sessions.registerSession(node.id, "cu@ops");
  sessions.updateStatus(session.id, "running");
  const codex = join(home, "codex"); const helper = join(home, "SkyComputerUseService");
  writeFileSync(codex, "v1"); writeFileSync(helper, "helper v1");
  recordLaunchFingerprint(home, node.id, "cu@ops", [{ label: "Codex", file: codex }, { label: "Codex computer-use helper", file: helper }]);
  writeFileSync(helper, "helper v2, updated by the app");
  const source = new RuntimeBinaryHealthSource({ home, rigRepo: rigs, sessionRegistry: sessions });
  expect(source.read()[0]).toMatchObject({ runtime: "Codex computer-use helper", binary: helper });
});

it("reads a launch record written before the computer-use change as a Codex binary", () => {
  const home = mkdtempSync(join(tmpdir(), "old-record-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const db = createDb(); migrate(db, ALL_MIGRATIONS); cleanups.push(() => db.close());
  const rigs = new RigRepository(db); const sessions = new SessionRegistry(db);
  const rig = rigs.createRig("old");
  const node = rigs.addNode(rig.id, "c", { role: "worker" });
  sessions.updateStatus(sessions.registerSession(node.id, "c@old").id, "running");
  const codex = join(home, "codex"); writeFileSync(codex, "v1");
  mkdirSync(join(home, "run", "runtime-binaries"), { recursive: true });
  writeFileSync(join(home, "run", "runtime-binaries", `${node.id}.json`), JSON.stringify({ file: codex, realpath: realpathSync(codex), mtimeMs: 1, size: 2, nodeId: node.id, sessionName: "c@old", recordedAt: new Date().toISOString() }));
  expect(new RuntimeBinaryHealthSource({ home, rigRepo: rigs, sessionRegistry: sessions }).read()[0]).toMatchObject({ runtime: "Codex", binary: codex });
});
