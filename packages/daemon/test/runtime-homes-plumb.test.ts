import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { RigSpecSchema } from "../src/domain/rigspec-schema.js";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import { getNodeInventory } from "../src/domain/node-inventory.js";
import type { RigSpec } from "../src/domain/types.js";
import { RigSpecExporter } from "../src/domain/rigspec-exporter.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { PodRepository } from "../src/domain/pod-repository.js";

const RIG_ROOT = "/project/rigs/tv";
const TV = path.join(os.homedir(), ".claude-tv");

const agentYaml = `name: impl\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []`;
const rawMember = (id: string, over: Record<string, unknown> = {}) => ({ id, agent_ref: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: ".", ...over });
const rawSpec = (members: Record<string, unknown>[], rigHomes?: Record<string, string>) =>
  ({ version: "0.2", name: "tv", ...(rigHomes ? { runtime_homes: rigHomes } : {}), pods: [{ id: "dev", label: "Dev", members, edges: [] }], edges: [] });

describe("runtime_homes reaches every node-creation path", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;
  beforeEach(() => {
    db = createFullTestDb();
    setup = createTestApp(db, { podInstantiatorFsOps: {
      readFile: (p: string) => { if (p.includes("agents/impl")) return agentYaml; throw new Error(`Not found: ${p}`); },
      exists: (p: string) => p.includes("agents/impl"),
    } });
  });
  afterEach(() => { db.close(); });

  const dirOf = (logicalId: string) =>
    (db.prepare("SELECT claude_config_dir FROM nodes WHERE logical_id = ?").get(logicalId) as { claude_config_dir: string | null }).claude_config_dir;

  async function tvRig() {
    const outcome = await setup.podInstantiator.materializeStructured(rawSpec([rawMember("impl"), rawMember("own", { runtime_homes: { claude: "/accounts/own" } })], { claude: "~/.claude-tv" }), RIG_ROOT);
    expect(outcome.ok).toBe(true);
    return (outcome as { result: { rigId: string } }).result.rigId;
  }

  it("materialize: the rig's dir lands on every seat, a member's own dir wins, and export keeps the rig's", async () => {
    const rigId = await tvRig();
    expect(dirOf("dev.impl")).toBe(TV);
    expect(dirOf("dev.own")).toBe("/accounts/own");
    const exported = new RigSpecExporter({ rigRepo: setup.rigRepo, sessionRegistry: new SessionRegistry(db), podRepo: new PodRepository(db) }).exportRig(rigId) as RigSpec;
    expect(exported.runtimeHomes).toEqual({ claude: TV });
  });

  it("a member added later inherits the rig's dir", async () => {
    const rigId = await tvRig();
    expect((await setup.podInstantiator.addMemberToPod(rigId, "dev", rawMember("late"), RIG_ROOT)).ok).toBe(true);
    expect(dirOf("dev.late")).toBe(TV);
  });

  it("an expanded pod inherits the rig's dir, and a member's own dir rides the expansion", async () => {
    const rigId = await tvRig();
    const expanded = await setup.rigExpansionService.expand({ rigId, rigRoot: RIG_ROOT, pod: { id: "qa", label: "QA", edges: [], members: [
      { id: "reviewer", runtime: "claude-code", agentRef: "local:agents/impl", profile: "default", cwd: "." },
      { id: "own", runtime: "claude-code", agentRef: "local:agents/impl", profile: "default", cwd: ".", runtimeHomes: { claude: "/accounts/qa" } },
    ] } });
    expect(expanded.ok, JSON.stringify(expanded)).toBe(true);
    expect(dirOf("qa.reviewer")).toBe(TV);
    expect(dirOf("qa.own")).toBe("/accounts/qa");
  });

  it("rig up from YAML stores the rig's dir and shows it in the resume hint", async () => {
    const yaml = RigSpecCodec.serialize(RigSpecSchema.normalize(rawSpec([rawMember("planner")], { claude: "~/.claude-tv" })) as unknown as RigSpec);
    const outcome = await setup.podInstantiator.instantiate(yaml, RIG_ROOT);
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(dirOf("dev.planner")).toBe(TV);
    const nodeId = (db.prepare("SELECT id FROM nodes WHERE logical_id = 'dev.planner'").get() as { id: string }).id;
    db.prepare("UPDATE sessions SET resume_token = 'abc', resume_type = 'claude_id' WHERE node_id = ?").run(nodeId);
    const entry = getNodeInventory(db, (outcome as { result: { rigId: string } }).result.rigId).find((e) => e.logicalId === "dev.planner");
    expect(entry?.resumeCommand).toContain(`CLAUDE_CONFIG_DIR='${TV}'`);
  });
});
