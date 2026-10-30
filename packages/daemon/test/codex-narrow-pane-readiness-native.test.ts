import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { CodexRuntimeAdapter, type CodexAdapterFsOps } from "../src/adapters/codex-runtime-adapter.js";
import { shellQuote } from "../src/adapters/shell-quote.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";

const run = promisify(exec);
const runFile = promisify(execFile);

// A stand-in for Codex's alternate-screen TUI: it draws its banner and composer only when the window has
// room, and redraws on resize, as Codex 0.161 did in a 97x2 pane. It runs under a launch script, so tmux
// names the shell as the pane's command while the Codex process is alive.
const FAKE_CODEX = `
const mode = process.argv[2];
const draw = () => {
  process.stdout.write("\\x1b[?1049h\\x1b[2J\\x1b[H");
  if (mode === "hidden" || process.stdout.rows < 10) return;
  process.stdout.write("OpenAI Codex (v0.0.0)\\r\\n\\r\\n› Ask Codex to do anything\\r\\n\\r\\n  gpt-5 medium · 0% used");
};
process.stdout.on("resize", draw);
draw();
setInterval(() => {}, 1000);
`;

const fsOps: CodexAdapterFsOps = {
  readFile: (p: string) => { throw new Error(`Not found: ${p}`); },
  writeFile: () => {}, exists: () => false, mkdirp: () => {},
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });

async function server(cols: number, rows: number, command: string | null) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-narrow-")));
  const socket = path.join(temp, "owned.sock");
  const env = { ...process.env, HOME: temp };
  delete env.TMUX;
  delete env.TMUX_TMPDIR;
  fs.mkdirSync(path.join(temp, "bin"));
  fs.copyFileSync(process.execPath, path.join(temp, "bin", "codex"));
  fs.writeFileSync(path.join(temp, "fake-codex.js"), FAKE_CODEX);
  const launch = path.join(temp, "launch.sh");
  fs.writeFileSync(launch, `${shellQuote(path.join(temp, "bin", "codex"))} ${shellQuote(path.join(temp, "fake-codex.js"))} ${command ?? ""}\necho exited\n`);
  const tmux = (...args: string[]) => runFile("tmux", ["-S", socket, ...args], { env });
  await runFile("tmux", ["-f", "/dev/null", "-S", socket, "new-session", "-d", "-s", "seat", "-x", String(cols), "-y", String(rows),
    ...(command === null ? ["sh"] : ["sh", launch])], { env });
  cleanups.push(async () => {
    // This socket belongs to this test, never the user's terminal server.
    await tmux("kill-server").catch(() => {});
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const adapter = new TmuxAdapter(async (cmd) => (await run(`tmux -S ${shellQuote(socket)} ${cmd.slice(5)}`, { env })).stdout);
  const codex = new CodexRuntimeAdapter({ tmux: adapter, fsOps });
  const binding: NodeBinding = { id: "b", nodeId: "n", tmuxSession: "seat", tmuxWindow: null, tmuxPane: null,
    cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: temp };
  const geometry = async () => (await tmux("display-message", "-p", "-t", "seat", "#{pane_width}x#{pane_height}")).stdout.trim();
  const windowSize = async () => (await tmux("show-options", "-wqv", "-t", "seat:", "window-size")).stdout.trim();
  await new Promise((r) => setTimeout(r, 800));
  binding.tmuxPane = (await tmux("display-message", "-p", "-t", "seat", "#{pane_id}")).stdout.trim();
  return { codex, binding, geometry, windowSize, tmux };
}

describe.skipIf(process.platform === "win32")("Codex readiness in a narrow pane (real tmux)", () => {
  const reveal = { revealNarrowScreen: true };

  it("a launch's wait sees a live Codex in a 97x2 pane as ready, and the pane returns to 97x2", async () => {
    const s = await server(97, 2, "");
    expect(await s.geometry()).toBe("97x2");
    expect(await s.codex.checkReady(s.binding, reveal)).toEqual({ ready: true });
    expect(await s.geometry()).toBe("97x2");
    expect(await s.windowSize()).toBe("");
  });

  it("a window-level window-size is put back after the reveal", async () => {
    const s = await server(97, 2, "");
    await s.tmux("set-option", "-w", "-t", "seat:", "window-size", "smallest");
    expect(await s.codex.checkReady(s.binding, reveal)).toEqual({ ready: true });
    expect(await s.windowSize()).toBe("smallest");
  });

  it("overlapping reveals leave no window-local window-size behind", async () => {
    const s = await server(97, 2, "");
    const results = await Promise.all([s.codex.checkReady(s.binding, reveal), s.codex.checkReady(s.binding, reveal)]);
    expect(results).toContainEqual({ ready: true });
    expect(await s.geometry()).toBe("97x2");
    expect(await s.windowSize()).toBe("");
  });

  it("a normal pane is ready without any resize", async () => {
    const s = await server(120, 40, "");
    expect(await s.codex.checkReady(s.binding, reveal)).toEqual({ ready: true });
    expect(await s.geometry()).toBe("120x40");
    expect(await s.windowSize()).toBe("");
  });

  it("other callers never resize: a hidden live Codex is awaiting, never returned to shell", async () => {
    const s = await server(97, 2, "");
    expect(await s.codex.checkReady(s.binding)).toMatchObject({ ready: false, code: "awaiting_runtime" });
    expect(await s.geometry()).toBe("97x2");
    expect(await s.windowSize()).toBe("");
  });

  it("a split window is left alone", async () => {
    const s = await server(97, 4, "");
    await s.tmux("split-window", "-d", "-t", "seat:", "sleep 60");
    const before = (await s.tmux("list-panes", "-t", "seat:", "-F", "#{pane_width}x#{pane_height}")).stdout;
    expect(await s.codex.checkReady(s.binding, reveal)).toMatchObject({ ready: false, code: "awaiting_runtime" });
    expect((await s.tmux("list-panes", "-t", "seat:", "-F", "#{pane_width}x#{pane_height}")).stdout).toBe(before);
    expect(await s.windowSize()).toBe("");
  });

  it("a live Codex whose screen shows no conversation is awaiting after the reveal", async () => {
    const s = await server(97, 2, "hidden");
    expect(await s.codex.checkReady(s.binding, reveal)).toMatchObject({ ready: false, code: "awaiting_runtime" });
    expect(await s.geometry()).toBe("97x2");
  });

  it("a pane with no Codex process still reports returned to shell and is not resized", async () => {
    const s = await server(97, 2, null);
    expect(await s.codex.checkReady(s.binding, reveal)).toMatchObject({ ready: false, code: "returned_to_shell" });
    expect(await s.windowSize()).toBe("");
  });
});
