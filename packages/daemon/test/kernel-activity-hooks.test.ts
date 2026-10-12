import { afterEach, describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { builtInKernelVariant, currentKernelActivityHookSelection } from "../src/domain/kernel-activity-hooks.js";

const shippedSpecs = resolve(__dirname, "../specs");
const fsOps = { readFile: (p: string) => readFileSync(p, "utf8"), exists: (p: string) => existsSync(p) };
const advisor = { logicalId: "advisor.lead", agentRef: "local:agents/advisor/lead", profile: "default", runtime: "claude-code", fsOps };
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("built-in kernel provenance", () => {
  function rigWithRun(name: string, run: { sourceRef: string; linked: "id" | "window" | "outside"; status?: string }) {
    const db = createFullTestDb();
    db.prepare("INSERT INTO rigs (id, name, created_at) VALUES ('r1', ?, '2026-10-02 11:28:17')").run(name);
    const [created, applied] = run.linked === "outside" ? ["2026-10-01 09:00:00", "2026-10-01T09:00:20.000Z"] : ["2026-10-02 11:28:17", "2026-10-02T11:28:37.690Z"];
    db.prepare("INSERT INTO bootstrap_runs (id, source_kind, source_ref, status, rig_id, created_at, applied_at) VALUES ('b1', 'rig_spec', ?, ?, ?, ?, ?)")
      .run(run.sourceRef, run.status ?? "completed", run.linked === "id" ? "r1" : null, created, applied);
    return db;
  }
  const shipped = (variant: string) => `/Users/x/Library/pnpm/store/v11/links/@openrig/cli/0.6.3/abc/node_modules/@openrig/cli/daemon/specs/rigs/launch/kernel/${variant}`;

  it("names the shipped variant of a kernel rig its completed bootstrap run created, by id or (older runs) by creation window", () => {
    for (const variant of ["rig.yaml", "rig-claude-only.yaml", "rig-codex-only.yaml"]) {
      expect(builtInKernelVariant(rigWithRun("kernel", { sourceRef: shipped(variant), linked: "id" }), "r1", shippedSpecs)).toBe(variant);
    }
    expect(builtInKernelVariant(rigWithRun("kernel", { sourceRef: shipped("rig.yaml"), linked: "window" }), "r1", shippedSpecs)).toBe("rig.yaml");
    expect(builtInKernelVariant(rigWithRun("kernel", { sourceRef: shipped("rig.yaml"), linked: "id", status: "partial" }), "r1", shippedSpecs)).toBe("rig.yaml");
  });

  it("a rig merely named kernel (a user spec, an unrelated or failed run) is not the built-in kernel", () => {
    expect(builtInKernelVariant(rigWithRun("kernel", { sourceRef: "/Users/x/my-rigs/kernel/rig.yaml", linked: "id" }), "r1", shippedSpecs)).toBeNull();
    expect(builtInKernelVariant(rigWithRun("kernel", { sourceRef: shipped("rig.yaml"), linked: "outside" }), "r1", shippedSpecs)).toBeNull();
    expect(builtInKernelVariant(rigWithRun("kernel", { sourceRef: shipped("rig.yaml"), linked: "id", status: "failed" }), "r1", shippedSpecs)).toBeNull();
    expect(builtInKernelVariant(rigWithRun("finance", { sourceRef: shipped("rig.yaml"), linked: "id" }), "r1", shippedSpecs)).toBeNull();
    expect(builtInKernelVariant(rigWithRun("kernel", { sourceRef: shipped("rig-experimental.yaml"), linked: "id" }), "r1", shippedSpecs)).toBeNull();
    expect(builtInKernelVariant(rigWithRun("kernel", { sourceRef: "/Users/x/dev/openrig-fork/packages/daemon/specs/rigs/launch/kernel/rig.yaml", linked: "id" }), "r1", shippedSpecs)).toBeNull();
    expect(builtInKernelVariant(rigWithRun("kernel", { sourceRef: `${shippedSpecs}/rigs/launch/kernel/rig.yaml`, linked: "id" }), "r1", shippedSpecs)).toBe("rig.yaml");
  });
});

describe("the current kernel definition's activity-hook selection", () => {
  it("the shipped kernel variants select activity hooks for the advisor", () => {
    for (const variant of ["rig.yaml", "rig-claude-only.yaml"]) {
      expect(currentKernelActivityHookSelection({ specsDir: shippedSpecs, variant, ...advisor })).toBe("selected");
    }
  });

  it("an explicit selection without hooks, or a profile override that lacks them, is not-selected; a non-Claude seat never selects them", () => {
    const specs = mkdtempSync(join(tmpdir(), "kernel-specs-")); dirs.push(specs);
    cpSync(shippedSpecs, specs, { recursive: true });
    const agent = join(specs, "rigs/launch/kernel/agents/advisor/lead/agent.yaml");
    const original = readFileSync(agent, "utf8");
    writeFileSync(agent, original.replace(", shared:claude-activity-hooks]", "]"));
    expect(currentKernelActivityHookSelection({ specsDir: specs, variant: "rig.yaml", ...advisor })).toBe("not-selected");
    writeFileSync(agent, original.replace("profiles:\n", "profiles:\n  quiet:\n    uses:\n      skills: []\n      guidance: []\n      subagents: []\n      plugins: []\n      runtime_resources: [shared:claude-default-settings]\n"));
    expect(currentKernelActivityHookSelection({ specsDir: specs, variant: "rig.yaml", ...advisor, profile: "quiet" })).toBe("not-selected");
    expect(currentKernelActivityHookSelection({ specsDir: specs, variant: "rig.yaml", ...advisor })).toBe("selected");
    expect(currentKernelActivityHookSelection({ specsDir: specs, variant: "rig.yaml", ...advisor, runtime: "codex" })).toBe("not-selected");
  });

  it("a seat that differs from the installed definition, or a missing variant, is unresolved", () => {
    expect(currentKernelActivityHookSelection({ specsDir: shippedSpecs, variant: "rig.yaml", ...advisor, agentRef: "local:agents/elsewhere" }))
      .toEqual({ unresolved: "the seat differs from its current rig spec definition" });
    expect(currentKernelActivityHookSelection({ specsDir: shippedSpecs, variant: "rig-codex-only.yaml", ...advisor })).toHaveProperty("unresolved");
    expect(currentKernelActivityHookSelection({ specsDir: "/nonexistent", variant: "rig.yaml", ...advisor })).toHaveProperty("unresolved");
  });
});

describe("restore reconciles only the kernel seat's activity-hook entry", () => {
  type Entries = Array<{ category: string; resourceType?: string; effectiveId: string }>;
  function orchestrator(rigName: string, kernelRun: boolean) {
    const db = createFullTestDb();
    const app = createTestApp(db);
    const rig = app.rigRepo.createRig(rigName);
    if (kernelRun) {
      db.prepare("INSERT INTO bootstrap_runs (id, source_kind, source_ref, status, rig_id, created_at, applied_at) VALUES ('b1', 'rig_spec', ?, 'completed', ?, datetime('now'), ?)")
        .run(`${shippedSpecs}/rigs/launch/kernel/rig.yaml`, rig.id, new Date().toISOString());
    }
    const orch = app.restoreOrchestrator as unknown as { specsDir?: string; activityHookEntries: (rigId: string, node: unknown, saved: Entries, warnings: string[]) => Entries };
    orch.specsDir = shippedSpecs;
    return { rigId: rig.id, entries: (node: object, saved: Entries) => { const warnings: string[] = []; return { entries: orch.activityHookEntries(rig.id, node, saved, warnings), warnings }; } };
  }
  const savedWithoutHooks: Entries = [{ category: "plugin", effectiveId: "shared:openrig-core" }, { category: "runtime_resource", resourceType: "claude_settings_fragment", effectiveId: "shared:claude-default-settings" }];
  const node = { logicalId: "advisor.lead", agentRef: "local:agents/advisor/lead", profile: "default", runtime: "claude-code" };

  it("a built-in kernel seat whose saved context predates the resource gets the hook marker; a saved hook entry is used as is", () => {
    const k = orchestrator("kernel", true);
    expect(k.entries(node, savedWithoutHooks).entries).toEqual([expect.objectContaining({ resourceType: "claude_activity_hooks", category: "runtime_resource" })]);
    const saved = { category: "runtime_resource", resourceType: "claude_activity_hooks", effectiveId: "claude-activity-hooks" };
    expect(k.entries(node, [...savedWithoutHooks, saved]).entries).toEqual([saved]);
  });

  it("a non-kernel rig resolves its seat against the rig spec its rig up recorded: selected adds the marker, a missing spec keeps the saved selection with a warning", () => {
    const specs = mkdtempSync(join(tmpdir(), "user-rig-specs-")); dirs.push(specs);
    cpSync(shippedSpecs, specs, { recursive: true });
    const db = createFullTestDb();
    const app = createTestApp(db);
    const rig = app.rigRepo.createRig("psa");
    const specPath = join(specs, "rigs/launch/kernel/rig.yaml");
    db.prepare("INSERT INTO bootstrap_runs (id, source_kind, source_ref, status, rig_id, created_at, applied_at) VALUES ('b1', 'rig_spec', ?, 'completed', ?, datetime('now'), ?)")
      .run(specPath, rig.id, new Date().toISOString());
    const orch = app.restoreOrchestrator as unknown as { specsDir?: string; activityHookEntries: (rigId: string, node: unknown, saved: Entries, warnings: string[]) => Entries };
    orch.specsDir = shippedSpecs;
    const warnings: string[] = [];
    expect(orch.activityHookEntries(rig.id, node, savedWithoutHooks, warnings)).toEqual([expect.objectContaining({ resourceType: "claude_activity_hooks" })]);
    expect(warnings).toEqual([]);
    rmSync(specPath);
    expect(orch.activityHookEntries(rig.id, node, savedWithoutHooks, warnings)).toEqual([]);
    expect(warnings).toEqual([expect.stringContaining("is missing")]);
  });

  it("a rig named kernel without the built-in boot, and any local-ref seat of another rig, keep the saved selection with a warning", () => {
    for (const r of [orchestrator("kernel", false), orchestrator("finance", false)]) {
      const out = r.entries(node, savedWithoutHooks);
      expect(out.entries).toEqual([]);
      expect(out.warnings).toEqual([expect.stringContaining("could not be resolved (no rig root)")]);
    }
    expect(orchestrator("finance", false).entries({ ...node, agentRef: "builtin:terminal" }, savedWithoutHooks)).toEqual({ entries: [], warnings: [] });
  });
});
