// A Codex update on disk under a running seat is a health finding with a same-conversation restart.
import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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
import { recordLaunchFingerprint } from "../src/domain/runtime-binary-fingerprint.js";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).reverse().forEach((f) => f()));

it("finds a Codex binary changed since the seat launched, with the restart command; an unchanged one is quiet", () => {
  const home = mkdtempSync(join(tmpdir(), "binary-drift-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const db = createDb(); migrate(db, ALL_MIGRATIONS); cleanups.push(() => db.close());
  const rigs = new RigRepository(db); const sessions = new SessionRegistry(db);
  const rig = rigs.createRig("psa");
  const node = rigs.addNode(rig.id, "psa-dev", { role: "worker" });
  const session = sessions.registerSession(node.id, "psa-dev@psa");
  sessions.updateStatus(session.id, "running");
  const codex = join(home, "codex");
  writeFileSync(codex, "#!/bin/sh\necho v1\n");
  recordLaunchFingerprint(home, node.id, "psa-dev@psa", codex);
  const source = new RuntimeBinaryHealthSource({ home, rigRepo: rigs, sessionRegistry: sessions });
  expect(source.read()).toEqual([]);

  writeFileSync(codex, "#!/bin/sh\necho v2 with a longer body\n");
  utimesSync(codex, new Date(), new Date(Date.now() + 5000));
  const [finding] = source.read();
  expect(finding).toMatchObject({ kind: "runtime-binary-drift", sessionName: "psa-dev@psa", binary: codex, restartCommand: "rig seat stop psa-dev@psa && rig up psa --existing" });
  const policy = new HealthPolicyStore(home, () => ({ warningPercent: 95, criticalPercent: 99 }));
  const [record] = new HealthProjectionService(source, () => policy.read(), delegatedPostureFixture).list().records;
  expect(record).toMatchObject({ detector: "runtime.binary-drift", severity: "warning" });
  expect(JSON.stringify(record)).toContain("rig seat stop psa-dev@psa && rig up psa --existing");
});
