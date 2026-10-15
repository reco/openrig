import fs from "node:fs";
import { Hono } from "hono";
import type { Context } from "hono";
import type { RigSpecExporter } from "../domain/rigspec-exporter.js";
import type { RigInstantiator, PodRigInstantiator } from "../domain/rigspec-instantiator.js";
import type { RigSpecPreflight } from "../domain/rigspec-preflight.js";
import type { RigRepository } from "../domain/rig-repository.js";
import type { RigSpec } from "../domain/types.js";
import nodePath from "node:path";
import { DEFAULT_CLAUDE_MANAGED_BLOCK_FILE, DEFAULT_CODEX_MANAGED_BLOCK_FILE, stripManagedBlocks } from "../domain/managed-blocks.js";
import { LegacyRigSpecCodec } from "../domain/rigspec-codec.js";
import { RigSpecCodec } from "../domain/rigspec-codec.js";
import { LegacyRigSpecSchema } from "../domain/rigspec-schema.js";
import { RigSpecSchema } from "../domain/rigspec-schema.js";
import { rigPreflight } from "../domain/rigspec-preflight.js";
import { RigNotFoundError } from "../domain/errors.js";
import { runSyncSite } from "../domain/sync-site-wrap.js";
import { runtimeVersionProbeCwd } from "../adapters/preflight-exec.js";
import { RigSpecParseError, validateRigSpecImport } from "../domain/spec-validation-service.js";

export const rigspecImportRoutes = new Hono();

function getDeps(c: { get: (key: string) => unknown }) {
  return {
    exporter: c.get("rigSpecExporter" as never) as RigSpecExporter,
    instantiator: c.get("rigInstantiator" as never) as RigInstantiator,
    preflight: c.get("rigSpecPreflight" as never) as RigSpecPreflight,
    podInstantiator: c.get("podInstantiator" as never) as PodRigInstantiator,
    rigRepo: c.get("rigRepo" as never) as RigRepository,
  };
}

// GET /api/rigs/:rigId/spec -> YAML
export function handleExportYaml(c: Context): Response {
  const rigId = c.req.param("rigId")!;
  const { exporter } = getDeps(c);

  try {
    const spec = exporter.exportRig(rigId);
    // Detect format: pod-aware RigSpec has `pods`, legacy has `schemaVersion`
    const isPodAware = "pods" in spec;
    const yaml = isPodAware
      ? RigSpecCodec.serialize(spec as import("../domain/types.js").RigSpec)
      : LegacyRigSpecCodec.serialize(spec as import("../domain/types.js").LegacyRigSpec);
    return new Response(yaml, {
      status: 200,
      headers: { "Content-Type": "text/yaml" },
    });
  } catch (err) {
    if (err instanceof RigNotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    return c.json({ error: "Export failed" }, 500);
  }
}

// GET /api/rigs/:rigId/spec.json -> JSON
export function handleExportJson(c: Context): Response {
  const rigId = c.req.param("rigId")!;
  const { exporter } = getDeps(c);

  try {
    const spec = exporter.exportRig(rigId);
    return c.json(spec);
  } catch (err) {
    if (err instanceof RigNotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    return c.json({ error: "Export failed" }, 500);
  }
}

// POST /api/rigs/import -> instantiate from YAML
rigspecImportRoutes.post("/", async (c) => {
  const { instantiator, podInstantiator } = getDeps(c);
  const body = await c.req.text();

  let raw: unknown;
  try {
    raw = RigSpecCodec.parse(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message, errors: [message] }, 400);
  }

  const isPodAware = raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).pods);

  if (isPodAware) {
    const rigRoot = c.req.header("X-Rig-Root");
    if (!rigRoot) return c.json({ error: "X-Rig-Root header required for pod-aware specs", code: "missing_rig_root" }, 400);
    const cwdOverride = c.req.header("X-Cwd-Override") ?? undefined;

    const outcome = await podInstantiator.instantiate(body, rigRoot, { cwdOverride });
    if (!outcome.ok) {
      const status = outcome.code === "validation_failed" ? 400
        : outcome.code === "preflight_failed" ? 409
        : outcome.code === "cycle_error" ? 400
        // S5b final-fix F1: the running-name guard refusal is a conflict on the
        // direct instantiation route too — never a 500 (map consistency).
        : outcome.code === "rig_name_running" ? 409
        // #141: an import refused because a same-name rig could not be confirmed stopped.
        : outcome.code === "generation_unconfirmed" ? 409
        // A Compose project conflict is an actionable request conflict, not a server failure.
        : outcome.code === "compose_project_conflict" ? 409
        : 500;
      const body = outcome.code === "rig_name_running" || outcome.code === "generation_unconfirmed" || outcome.code === "compose_project_conflict"
        ? { ...outcome, error: outcome.message }
        : outcome;
      return c.json(body, status);
    }
    return c.json(outcome.result, 201);
  }

  // Legacy path
  let spec;
  try {
    spec = LegacyRigSpecSchema.normalize(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message, errors: [message] }, 400);
  }

  const outcome = await instantiator.instantiate(spec);
  if (!outcome.ok) {
    const status = outcome.code === "validation_failed" ? 400
      : outcome.code === "preflight_failed" ? 409
      : outcome.code === "rig_name_running" ? 409
      : 500;
    const body = outcome.code === "rig_name_running"
      ? { ...outcome, error: outcome.message }
      : outcome;
    return c.json(body, status);
  }
  return c.json(outcome.result, 201);
});

// POST /api/rigs/import/workspace -> apply only a validated workspace declaration
rigspecImportRoutes.post("/workspace", async (c) => {
  const { rigRepo } = getDeps(c);
  const targetRigId = c.req.header("X-Target-Rig-Id");
  if (!targetRigId) {
    return c.json({ ok: false, code: "target_rig_required", error: "X-Target-Rig-Id header required for workspace-only apply" }, 400);
  }

  const body = await c.req.text();
  let raw: unknown;
  try {
    raw = RigSpecCodec.parse(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, code: "validation_failed", errors: [message] }, 400);
  }

  const workspace = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)["workspace"]
    : undefined;
  if (workspace === undefined || workspace === null) {
    return c.json({ ok: false, code: "workspace_required", errors: ["workspace: required for workspace-only apply"] }, 400);
  }

  const validation = RigSpecSchema.validateWorkspace(workspace);
  if (!validation.valid) {
    return c.json({ ok: false, code: "validation_failed", errors: validation.errors }, 400);
  }

  const normalizedWorkspace = RigSpecSchema.normalizeWorkspace(workspace)!;
  if (!rigRepo.getRig(targetRigId)) {
    return c.json({ ok: false, code: "target_rig_not_found", error: `Rig not found: ${targetRigId}` }, 404);
  }

  const current = rigRepo.getRigWorkspace(targetRigId);
  const changed = JSON.stringify(current) !== JSON.stringify(normalizedWorkspace);
  if (changed) rigRepo.setRigWorkspace(targetRigId, normalizedWorkspace);

  return c.json({ rigId: targetRigId, changed, workspace: normalizedWorkspace });
});

// POST /api/rigs/import/managed-blocks -> set an existing rig's managed-block files from the spec's
// managed_blocks (a runtime left out goes back to its default). Files and running seats are not
// touched: the next launch, restore or relaunch writes the selected file. A change is refused while a
// member's previously selected file still holds managed blocks, because nothing would clean that file
// later (teardown cleans the selected file only) and Claude would load both copies, or an
// AGENTS.override.md would keep hiding AGENTS.md.
rigspecImportRoutes.post("/managed-blocks", async (c) => {
  const { rigRepo } = getDeps(c);
  const targetRigId = c.req.header("X-Target-Rig-Id");
  if (!targetRigId) {
    return c.json({ ok: false, code: "target_rig_required", error: "X-Target-Rig-Id header required for managed-blocks-only apply" }, 400);
  }
  let raw: unknown;
  try {
    raw = RigSpecCodec.parse(await c.req.text());
  } catch (err) {
    return c.json({ ok: false, code: "validation_failed", errors: [err instanceof Error ? err.message : String(err)] }, 400);
  }
  const managedBlocks = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)["managed_blocks"]
    : undefined;
  if (managedBlocks === undefined) {
    return c.json({ ok: false, code: "managed_blocks_required", errors: ["managed_blocks: required for managed-blocks-only apply ({} restores the defaults)"] }, 400);
  }
  const errors = RigSpecSchema.validateManagedBlocks(managedBlocks);
  if (errors.length) return c.json({ ok: false, code: "validation_failed", errors }, 400);
  const rig = rigRepo.getRig(targetRigId);
  if (!rig) {
    return c.json({ ok: false, code: "target_rig_not_found", error: `Rig not found: ${targetRigId}` }, 404);
  }
  const selected = managedBlocks as NonNullable<RigSpec["managedBlocks"]>;
  const before = { "claude-code": rigRepo.getRigClaudeManagedBlockFile(targetRigId), codex: rigRepo.getRigCodexManagedBlockFile(targetRigId) };
  const after = { "claude-code": selected["claude-code"] ?? null, codex: selected.codex ?? null };
  const changed = JSON.stringify(before) !== JSON.stringify(after);
  const defaults = { "claude-code": DEFAULT_CLAUDE_MANAGED_BLOCK_FILE, codex: DEFAULT_CODEX_MANAGED_BLOCK_FILE };
  const stale = new Set<string>();
  for (const runtime of ["claude-code", "codex"] as const) {
    const previous = before[runtime] ?? defaults[runtime];
    if (previous === (after[runtime] ?? defaults[runtime])) continue;
    for (const node of rig.nodes) {
      if (node.runtime !== runtime || !node.cwd) continue;
      const path = nodePath.join(node.cwd, previous);
      const text = fs.existsSync(path) ? fs.readFileSync(path, "utf-8") : "";
      if (stripManagedBlocks(text) !== text.trim()) stale.add(path);
    }
  }
  if (stale.size) {
    return c.json({ ok: false, code: "previous_file_has_managed_blocks", errors: [...stale].map((path) =>
      `${path} still holds OpenRig managed blocks; remove each BEGIN/END OpenRig MANAGED BLOCK section (keep the rest of the file), then apply again`) }, 409);
  }
  if (changed) {
    rigRepo.setRigClaudeManagedBlockFile(targetRigId, after["claude-code"]);
    rigRepo.setRigCodexManagedBlockFile(targetRigId, after.codex);
  }
  return c.json({ rigId: targetRigId, changed, before, managedBlocks: after });
});

// POST /api/rigs/import/materialize -> create rig topology without launching
rigspecImportRoutes.post("/materialize", async (c) => {
  const { podInstantiator } = getDeps(c);
  const body = await c.req.text();

  let raw: unknown;
  try {
    raw = RigSpecCodec.parse(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message, errors: [message] }, 400);
  }

  const isPodAware = raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).pods);
  if (!isPodAware) {
    return c.json({ error: "materialize-only requires a pod-aware RigSpec", code: "pod_aware_required" }, 400);
  }

  const rigRoot = c.req.header("X-Rig-Root");
  if (!rigRoot) return c.json({ error: "X-Rig-Root header required for pod-aware specs", code: "missing_rig_root" }, 400);

  const targetRigId = c.req.header("X-Target-Rig-Id") ?? undefined;
  const cwdOverride = c.req.header("X-Cwd-Override") ?? undefined;
  const outcome = await podInstantiator.materialize(body, rigRoot, { targetRigId, cwdOverride });
  if (!outcome.ok) {
    const status = outcome.code === "validation_failed" ? 400
      : outcome.code === "preflight_failed" ? 409
      : outcome.code === "target_rig_not_found" ? 404
      : outcome.code === "materialize_conflict" ? 409
      : outcome.code === "rig_name_running" ? 409
      : 500;
    const body = outcome.code === "rig_name_running"
      ? { ...outcome, error: outcome.message }
      : outcome;
    return c.json(body, status);
  }
  return c.json(outcome.result, 201);
});

// POST /api/rigs/import/validate -> validate only (auto-detects format)
rigspecImportRoutes.post("/validate", async (c) => {
  const body = await c.req.text();
  try {
    return c.json(validateRigSpecImport(body));
  } catch (err) {
    if (!(err instanceof RigSpecParseError)) throw err;
    return c.json({ valid: false, errors: [err.message] }, 400);
  }
});

// POST /api/rigs/import/preflight -> validate + preflight (auto-detects format)
rigspecImportRoutes.post("/preflight", async (c) => {
  const { preflight, podInstantiator } = getDeps(c);
  const body = await c.req.text();

  let raw: unknown;
  try {
    raw = RigSpecCodec.parse(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ valid: false, errors: [message] }, 400);
  }

  const isPodAware = raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).pods);
  if (isPodAware) {
    const rigRoot = c.req.header("X-Rig-Root");
    if (!rigRoot) return c.json({ ready: false, errors: ["X-Rig-Root header required for pod-aware specs"], warnings: [] }, 400);
    const cwdOverride = c.req.header("X-Cwd-Override") ?? undefined;
    const fsOps = { readFile: (p: string) => fs.readFileSync(p, "utf-8"), exists: (p: string) => fs.existsSync(p) };
    const { execSync } = await import("node:child_process");
    const exec = async (cmd: string) => runSyncSite("rigspec.import.preflight", () =>
      execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 10_000, cwd: runtimeVersionProbeCwd(cmd) })
    );
    const result = await rigPreflight({
      rigSpecYaml: body,
      rigRoot,
      cwdOverride,
      fsOps,
      skillsRoot: podInstantiator.resolveSkillsRoot?.(),
      exec,
    });
    return c.json(result);
  }

  // Legacy
  let spec;
  try {
    spec = LegacyRigSpecSchema.normalize(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ valid: false, errors: [message] }, 400);
  }

  const result = await preflight.check(spec);
  return c.json(result);
});
