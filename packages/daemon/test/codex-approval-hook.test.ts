// The Slack approval hook for Codex seats: projected into the managed config.toml PermissionRequest
// group beside the activity relay (Codex reads no plugin hooks/codex.json), with its own trust record.
// The native check asks a real Codex app-server (`hooks/list`) whether both handlers load as trusted.
import { describe, it, expect, vi } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CodexRuntimeAdapter, type CodexAdapterFsOps } from "../src/adapters/codex-runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const SCRIPTS = path.resolve(__dirname, "../assets/plugins/openrig-core/hooks/scripts");
const RELAY = path.join(SCRIPTS, "activity-relay.cjs");
const APPROVAL = path.join(SCRIPTS, "approval-request.cjs");
const tmux = { sendText: vi.fn(async () => ({ ok: true as const })) } as unknown as TmuxAdapter;

function mockFs(files: Record<string, string>): CodexAdapterFsOps & { _store: Record<string, string> } {
  const store: Record<string, string> = { ...files };
  return {
    readFile: (p: string) => { if (p in store) return store[p]!; throw new Error(`Not found: ${p}`); },
    writeFile: (p: string, c: string) => { store[p] = c; },
    exists: (p: string) => p in store,
    mkdirp: () => {},
    listFiles: () => [],
    homedir: "/home/test",
    _store: store,
  } as CodexAdapterFsOps & { _store: Record<string, string> };
}

describe("Codex Slack approval hook projection", () => {
  it("adds the approval handler and its trust record to the managed PermissionRequest group", () => {
    const fs = mockFs({ [RELAY]: "", [APPROVAL]: "" });
    new CodexRuntimeAdapter({ tmux, fsOps: fs, activityRelayPath: RELAY }).ensureCodexActivityHooks();
    const cfg = fs._store["/home/test/.codex/config.toml"]!;
    const group = cfg.slice(cfg.indexOf("[[hooks.PermissionRequest]]"));
    expect(group).toContain(`command = 'node "${RELAY}"'\ntimeout = 5\n\n[[hooks.PermissionRequest.hooks]]\ntype = "command"\ncommand = 'node "${APPROVAL}"'\ntimeout = 3660`);
    expect(cfg).toContain('[hooks.state."/home/test/.codex/config.toml:permission_request:0:1"]');
  });

  it("projects no approval handler when the script is not shipped", () => {
    const fs = mockFs({ [RELAY]: "" });
    new CodexRuntimeAdapter({ tmux, fsOps: fs, activityRelayPath: RELAY }).ensureCodexActivityHooks();
    expect(fs._store["/home/test/.codex/config.toml"]).not.toContain("approval-request.cjs");
  });
});

function codexBinary(): string | null {
  const bin = process.env.CODEX_NATIVE_BIN ?? "codex";
  try {
    const version = execFileSync(bin, ["--version"], { encoding: "utf8" }).match(/(\d+)\.(\d+)/);
    return version && (Number(version[1]) > 0 || Number(version[2]) >= 161) ? bin : null;
  } catch { return null; }
}

async function listHooks(bin: string, codexHome: string): Promise<Array<Record<string, unknown>>> {
  const server = spawn(bin, ["app-server"], { env: { ...process.env, CODEX_HOME: codexHome }, stdio: ["pipe", "pipe", "ignore"] });
  const send = (message: unknown) => server.stdin.write(`${JSON.stringify(message)}\n`);
  try {
    return await new Promise((resolve, reject) => {
      let buffer = "";
      server.stdout.on("data", (chunk) => {
        buffer += chunk;
        for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
          const message = JSON.parse(buffer.slice(0, i));
          buffer = buffer.slice(i + 1);
          if (message.id === 1) { send({ method: "initialized" }); send({ id: 2, method: "hooks/list", params: { cwds: [codexHome] } }); }
          if (message.id === 2) resolve(message.result.data[0].hooks);
        }
      });
      server.on("error", reject);
      send({ id: 1, method: "initialize", params: { clientInfo: { name: "openrig-test", version: "0" } } });
    });
  } finally { server.kill(); }
}

const bin = codexBinary();
describe.skipIf(!bin)("native Codex (>= 0.161) loads the projected hooks as trusted", () => {
  it("both PermissionRequest handlers are trusted with their timeouts", async () => {
    const codexHome = mkdtempSync(path.join(tmpdir(), "codex-approval-native-"));
    try {
      const fsOps: CodexAdapterFsOps = { readFile: (p) => readFileSync(p, "utf8"), writeFile: (p, c) => writeFileSync(p, c), exists: existsSync, mkdirp: (p) => { mkdirSync(p, { recursive: true }); } };
      new CodexRuntimeAdapter({ tmux, fsOps, activityRelayPath: RELAY, codexHome }).ensureCodexActivityHooks();
      expect(readFileSync(path.join(codexHome, "config.toml"), "utf8")).toContain("approval-request.cjs");
      const hooks = await listHooks(bin!, codexHome);
      const permission = hooks.filter((h) => h.eventName === "permissionRequest").map((h) => ({ command: h.command, timeoutSec: h.timeoutSec, trustStatus: h.trustStatus }));
      expect(permission).toEqual([
        { command: `node "${RELAY}"`, timeoutSec: 5, trustStatus: "trusted" },
        { command: `node "${APPROVAL}"`, timeoutSec: 3660, trustStatus: "trusted" },
      ]);
      expect(hooks.every((h) => h.trustStatus === "trusted")).toBe(true);
    } finally { rmSync(codexHome, { recursive: true, force: true }); }
  }, 20_000);
});
