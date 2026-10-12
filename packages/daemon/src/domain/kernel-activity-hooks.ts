// A seat's saved startup context can predate the claude_activity_hooks resource, and restore
// re-projects only that saved selection. For the built-in kernel rig the current definition is
// known (the running install's shipped kernel spec, the variant its bootstrap ran), so restore can
// ask whether the seat's current agent spec selects the hooks; other rigs keep their saved selection.

import nodePath from "node:path";
import type Database from "better-sqlite3";
import { RigSpecCodec } from "./rigspec-codec.js";
import { RigSpecSchema } from "./rigspec-schema.js";
import { resolveAgentRef, type AgentResolverFsOps } from "./agent-resolver.js";
import { resolveNodeConfig } from "./profile-resolver.js";
import { CLAUDE_ACTIVITY_HOOKS_RESOURCE_TYPE } from "./claude-activity-hooks.js";

const SHIPPED_KERNEL_SPEC = /[\\/]specs[\\/]rigs[\\/]launch[\\/]kernel[\\/](rig|rig-claude-only|rig-codex-only)\.yaml$/;

const instant = (text: string) => Date.parse(/[TZ]/.test(text) ? text : `${text.replace(" ", "T")}Z`);

/** The shipped kernel variant (file name) this rig was booted from, or null when the rig did not come
 *  from the built-in kernel boot: its completed bootstrap run names a shipped kernel spec and created
 *  this rig (by id, or for runs that predate the recorded id, by the rig being created during the run). */
export function builtInKernelVariant(db: Database.Database, rigId: string): string | null {
  const rig = db.prepare("SELECT name, created_at FROM rigs WHERE id = ?").get(rigId) as { name: string; created_at: string } | undefined;
  if (rig?.name !== "kernel") return null;
  const created = instant(rig.created_at);
  const runs = db.prepare("SELECT source_ref, rig_id, created_at, applied_at FROM bootstrap_runs WHERE status = 'completed' AND source_kind = 'rig_spec'")
    .all() as Array<{ source_ref: string; rig_id: string | null; created_at: string; applied_at: string | null }>;
  const run = runs.find((r) => SHIPPED_KERNEL_SPEC.test(r.source_ref) && (r.rig_id === rigId
    || (r.rig_id === null && !!r.applied_at && instant(r.created_at) <= created && created <= instant(r.applied_at))));
  return run ? `${SHIPPED_KERNEL_SPEC.exec(run.source_ref)![1]}.yaml` : null;
}

export type ActivityHookSelection = "selected" | "not-selected" | { unresolved: string };

/** Whether the seat's current definition in the running install's kernel spec selects Claude activity hooks. */
export function currentKernelActivityHookSelection(input: {
  specsDir: string; variant: string; logicalId: string; agentRef: string | null; profile: string | null; runtime: string | null; fsOps: AgentResolverFsOps;
}): ActivityHookSelection {
  if (input.runtime !== "claude-code") return "not-selected";
  const root = nodePath.join(input.specsDir, "rigs", "launch", "kernel");
  const specPath = nodePath.join(root, input.variant);
  if (!input.fsOps.exists(specPath)) return { unresolved: `the installed kernel spec ${input.variant} is missing` };
  try {
    const spec = RigSpecSchema.normalize(RigSpecCodec.parse(input.fsOps.readFile(specPath)) as Record<string, unknown>);
    const pod = spec.pods.find((p) => p.id === input.logicalId.split(".")[0]);
    const member = pod?.members.find((m) => `${pod.id}.${m.id}` === input.logicalId);
    if (!pod || !member || member.agentRef !== input.agentRef || member.runtime !== input.runtime) {
      return { unresolved: "the seat differs from the installed kernel definition" };
    }
    const resolved = resolveAgentRef(member.agentRef, root, input.fsOps);
    if (!resolved.ok) return { unresolved: `agent_ref ${member.agentRef} did not resolve` };
    const config = resolveNodeConfig({ baseSpec: resolved.resolved, importedSpecs: resolved.imports, collisions: resolved.collisions,
      profileName: input.profile ?? member.profile, specRoot: root, member, pod, rig: spec });
    if (!config.ok) return { unresolved: config.errors.join("; ") };
    return config.config.selectedResources.runtimeResources.some((qr) => (qr.resource as { type?: string }).type === CLAUDE_ACTIVITY_HOOKS_RESOURCE_TYPE)
      ? "selected" : "not-selected";
  } catch (error) {
    return { unresolved: (error as Error).message };
  }
}
