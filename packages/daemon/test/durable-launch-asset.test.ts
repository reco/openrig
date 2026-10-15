// A launched Claude seat's --settings names its PreToolUse helper by absolute path for the seat's whole life.
// That path is a content-addressed copy under OPENRIG_HOME, not the package tree a global install prunes.
import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { durableLaunchAsset, durableLaunchAssets } from "../src/adapters/durable-launch-asset.js";
import { operationalLaunchArgs } from "../src/adapters/kernel-authority.js";
import { seedApprovalRules } from "../src/domain/approval-rules.js";

const HELPER = resolve(__dirname, "../assets/claude-team-permissions.cjs");
const SCRIPTS = resolve(__dirname, "../assets/plugins/openrig-core/hooks/scripts");
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const run = (helper: string, command: string) => spawnSync(process.execPath, [helper, Buffer.from(JSON.stringify({ allow: ["Bash(pwd:*)"], ask: [] })).toString("base64")],
  { input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }), encoding: "utf8" });

afterEach(() => vi.unstubAllEnvs());

describe("durable launch asset", () => {
  it("a launch's helper still runs after the package copy it came from is gone, its bytes and source recorded", () => {
    const home = mkdtempSync(join(tmpdir(), "launch-asset-home-"));
    const pkg = mkdtempSync(join(tmpdir(), "launch-asset-pkg-"));
    const source = join(pkg, "claude-team-permissions.cjs");
    copyFileSync(HELPER, source);
    const durable = durableLaunchAsset(source, home);
    expect(dirname(dirname(durable))).toBe(join(home, "launch-assets"));
    expect(durable.endsWith("/claude-team-permissions.cjs")).toBe(true);
    rmSync(pkg, { recursive: true, force: true });
    const r = run(durable, "pwd");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("allow");
    expect(sha(durable)).toBe(sha(HELPER));
    expect(JSON.parse(readFileSync(join(dirname(durable), "provenance.json"), "utf8")).files).toEqual([{ name: "claude-team-permissions.cjs", sha256: sha(HELPER), source }]);
  });

  it("helpers that require each other are copied side by side and still load once their package is gone", () => {
    const home = mkdtempSync(join(tmpdir(), "launch-asset-home-"));
    const pkg = mkdtempSync(join(tmpdir(), "launch-asset-pkg-"));
    const sources = ["activity-relay.cjs", "approval-request.cjs", "deny-check.cjs"].map((name) => { copyFileSync(join(SCRIPTS, name), join(pkg, name)); return join(pkg, name); });
    const copies = durableLaunchAssets(sources, home);
    expect(new Set(copies.map((c) => dirname(c))).size).toBe(1);
    rmSync(pkg, { recursive: true, force: true });
    for (const copy of copies) expect(spawnSync(process.execPath, ["-e", `require(${JSON.stringify(copy)})`], { encoding: "utf8" }).status).toBe(0);
  });

  it("the same bytes reuse one copy; a copy changed locally is never overwritten and never used, and that is logged", () => {
    const home = mkdtempSync(join(tmpdir(), "launch-asset-home-"));
    const durable = durableLaunchAsset(HELPER, home);
    expect(durableLaunchAsset(HELPER, home)).toBe(durable);
    chmodSync(durable, 0o644);
    writeFileSync(durable, "// edited by hand\n");
    const logs: string[] = [];
    expect(durableLaunchAsset(HELPER, home, (m) => logs.push(m))).toBe(HELPER);
    expect(readFileSync(durable, "utf8")).toBe("// edited by hand\n");
    expect(logs).toEqual([`launch helpers kept on the package path: ${durable} changed locally (left as is)`]);
  });

  it("an unwritable home leaves the launch on the package copy, and says so", () => {
    const home = mkdtempSync(join(tmpdir(), "launch-asset-home-"));
    writeFileSync(join(home, "launch-assets"), "not a directory");
    const logs: string[] = [];
    expect(durableLaunchAsset(HELPER, home, (m) => logs.push(m))).toBe(HELPER);
    expect(logs).toHaveLength(1);
  });

  it("a team Claude seat's launch settings name the durable copy, with its policy unchanged", () => {
    const home = mkdtempSync(join(tmpdir(), "launch-asset-rules-"));
    seedApprovalRules(home);
    vi.stubEnv("OPENRIG_HOME", home);
    const args = operationalLaunchArgs("claude-code", { teamPermissionDefault: true, launchPosture: "floor" });
    const command = JSON.parse(args[1]!).hooks.PreToolUse[0].hooks[0].command as string;
    const durable = durableLaunchAsset(HELPER, home);
    expect(durable).not.toBe(HELPER);
    expect(command).toContain(durable);
    expect(command).not.toContain(HELPER);
    expect(existsSync(durable)).toBe(true);
  });
});
