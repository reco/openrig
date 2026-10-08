import { mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface BinaryFingerprint {
  file: string;
  realpath: string;
  mtimeMs: number;
  size: number;
}

export interface LaunchFingerprint {
  nodeId: string;
  sessionName: string;
  recordedAt: string;
  binaries: Array<BinaryFingerprint & { label: string }>;
}

const dirOf = (home: string) => path.join(home, "run", "runtime-binaries");

export function fingerprintOf(file: string): BinaryFingerprint | null {
  try {
    const real = realpathSync(file);
    const st = statSync(real);
    return { file, realpath: real, mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

export function sameBinary(a: BinaryFingerprint, b: BinaryFingerprint | null): boolean {
  return !!b && a.realpath === b.realpath && a.mtimeMs === b.mtimeMs && a.size === b.size;
}

export function recordLaunchFingerprint(home: string, nodeId: string, sessionName: string, files: Array<{ label: string; file: string }>, now = new Date()): void {
  const binaries = files.flatMap(({ label, file }) => { const fp = fingerprintOf(file); return fp ? [{ ...fp, label }] : []; });
  if (binaries.length === 0) return;
  mkdirSync(dirOf(home), { recursive: true });
  const record: LaunchFingerprint = { nodeId, sessionName, recordedAt: now.toISOString(), binaries };
  writeFileSync(path.join(dirOf(home), `${encodeURIComponent(nodeId)}.json`), JSON.stringify(record));
}

export function readLaunchFingerprints(home: string): Map<string, LaunchFingerprint> {
  const out = new Map<string, LaunchFingerprint>();
  let names: string[] = [];
  try { names = readdirSync(dirOf(home)); } catch { return out; }
  for (const name of names.filter((n) => n.endsWith(".json"))) {
    try {
      const record = JSON.parse(readFileSync(path.join(dirOf(home), name), "utf8")) as LaunchFingerprint;
      if (record.nodeId && Array.isArray(record.binaries)) out.set(record.nodeId, record);
    } catch { /* unreadable record */ }
  }
  return out;
}

/** The Codex app's computer-use helper, when the seat's Codex config enables a computer-use plugin. */
export function computerUseHelperBinaries(codexConfigToml: string, homeDir: string): Array<{ label: string; file: string }> {
  const enabled = /\[plugins\."(?:unified-)?computer-use@[^"]+"\]\s*\n\s*enabled\s*=\s*true/.test(codexConfigToml);
  if (!enabled) return [];
  const app = /^\s*SKY_CUA_SERVICE_PATH\s*=\s*"([^"]+)"/m.exec(codexConfigToml)?.[1] ?? path.join(homeDir, ".codex", "computer-use", "Codex Computer Use.app");
  return [
    { label: "Codex computer-use helper", file: path.join(app, "Contents", "MacOS", "SkyComputerUseService") },
    { label: "Codex computer-use client", file: path.join(app, "Contents", "SharedSupport", "SkyComputerUseClient.app", "Contents", "MacOS", "SkyComputerUseClient") },
  ];
}
