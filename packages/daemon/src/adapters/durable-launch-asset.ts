import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const sha256Of = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function writeOnce(path: string, bytes: Buffer | string, mode: number): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, bytes, { mode });
  try { linkSync(tmp, path); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  finally { rmSync(tmp, { force: true }); }
}

/** A launch helper copy that outlives the package it came from (a global install prunes old package trees, while a
 *  launched seat keeps its helper's path for life): OPENRIG_HOME/launch-assets/<sha256 prefix>/<name>, written once,
 *  read-only, its source recorded beside it. A copy whose bytes no longer match was changed locally: it is left as it
 *  is and the package copy is used, as on any failure. */
export function durableLaunchAsset(source: string, home: string): string {
  try {
    const bytes = readFileSync(source);
    const sha256 = sha256Of(bytes);
    const dir = join(home, "launch-assets", sha256.slice(0, 16));
    const target = join(dir, basename(source));
    if (!existsSync(target)) {
      mkdirSync(dir, { recursive: true });
      writeOnce(join(dir, "provenance.json"), `${JSON.stringify({ sha256, source, writtenAt: new Date().toISOString() }, null, 2)}\n`, 0o444);
      writeOnce(target, bytes, 0o444);
    }
    return sha256Of(readFileSync(target)) === sha256 ? target : source;
  } catch {
    return source;
  }
}
