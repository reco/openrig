import { mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface BinaryFingerprint {
  file: string;
  realpath: string;
  mtimeMs: number;
  size: number;
}

export interface LaunchFingerprint extends BinaryFingerprint {
  nodeId: string;
  sessionName: string;
  recordedAt: string;
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

export function recordLaunchFingerprint(home: string, nodeId: string, sessionName: string, file: string, now = new Date()): void {
  const fp = fingerprintOf(file);
  if (!fp) return;
  mkdirSync(dirOf(home), { recursive: true });
  const record: LaunchFingerprint = { ...fp, nodeId, sessionName, recordedAt: now.toISOString() };
  writeFileSync(path.join(dirOf(home), `${encodeURIComponent(nodeId)}.json`), JSON.stringify(record));
}

export function readLaunchFingerprints(home: string): Map<string, LaunchFingerprint> {
  const out = new Map<string, LaunchFingerprint>();
  let names: string[] = [];
  try { names = readdirSync(dirOf(home)); } catch { return out; }
  for (const name of names.filter((n) => n.endsWith(".json"))) {
    try {
      const record = JSON.parse(readFileSync(path.join(dirOf(home), name), "utf8")) as LaunchFingerprint;
      if (record.nodeId && record.file) out.set(record.nodeId, record);
    } catch { /* unreadable record */ }
  }
  return out;
}
