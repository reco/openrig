import { afterEach, describe, expect, it } from "vitest";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { TranscriptStore } from "../src/domain/transcript-store.js";
import { WhoamiService } from "../src/domain/whoami-service.js";
import { AppliedLaunchObservationStore } from "../src/domain/applied-launch-observation-store.js";

describe("whoami occupancy", () => {
  const dbs: ReturnType<typeof createFullTestDb>[] = [];
  afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

  it("reports the native session, generation, recorded launch process and applied policy from the daemon's own records", () => {
    const db = createFullTestDb(); dbs.push(db);
    const rigRepo = new RigRepository(db), registry = new SessionRegistry(db);
    const rig = rigRepo.createRig("kernel");
    const node = rigRepo.addNode(rig.id, "queue.worker", { runtime: "codex", cwd: "/ws" });
    const session = registry.registerSession(node.id, "queue-worker@kernel");
    const svc = new WhoamiService({ db, rigRepo, sessionRegistry: registry, transcriptStore: new TranscriptStore({ transcriptsRoot: "/tmp/none", enabled: false }) });
    expect(svc.resolve({ sessionName: "queue-worker@kernel", compact: true })!.occupancy).toMatchObject({ nativeSessionId: null, launchProcess: null, appliedLaunch: null });

    registry.updateResumeToken(session.id, "codex_id", "01a0fc5f-thread", "hook");
    registry.recordResumeLaunchProcess(session.id, "01a0fc5f-thread", { pid: 4242, startedAt: "Mon Oct 13 07:09:16 2026" });
    const tenure = registry.currentOccupantTenure(node.id)!;
    new AppliedLaunchObservationStore(db).recordGeneration(tenure.generationUuid, { runtime: "codex", axis: "sandbox", state: "observed", value: "workspace-write", reason: "emitted_launch_arguments" });

    expect(svc.resolve({ sessionName: "queue-worker@kernel", compact: true })!.occupancy).toEqual({
      nativeSessionId: "01a0fc5f-thread",
      resumeType: "codex_id",
      generation: tenure.generationUuid,
      generationOrdinal: tenure.generationOrdinal,
      bootAt: tenure.bootAt,
      launchProcess: { pid: 4242, startedAt: "Mon Oct 13 07:09:16 2026" },
      appliedLaunch: { axis: "sandbox", value: "workspace-write", approvalPolicy: null },
    });
  });
});
