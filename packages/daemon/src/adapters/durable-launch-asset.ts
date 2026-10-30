import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const sha256Of = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

function writeOnce(path: string, bytes: Buffer | string, mode: number): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, bytes, { mode });
  try { linkSync(tmp, path); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  finally { rmSync(tmp, { force: true }); }
}

/** Launch helper copies that outlive the package they came from (a global install prunes old package trees, while
 *  a launched seat keeps its helpers' paths for life): OPENRIG_HOME/launch-assets/<sha256 prefix>/<name>, one
 *  directory per set of files (helpers that require each other stay side by side), written once, read-only, their
 *  sources recorded beside them. A copy whose bytes no longer match was changed locally: it is left as it is and the
 *  package copies are used, as on any failure. */
export function durableLaunchAssets(sources: readonly string[], home: string, log: (msg: string) => void = (m) => console.error(`[openrig] ${m}`)): string[] {
  try {
    const files = sources.map((source) => ({ source, name: basename(source), bytes: readFileSync(source) }));
    const shas = files.map((f) => sha256Of(f.bytes));
    const dir = join(home, "launch-assets", sha256Of(files.map((f, i) => `${f.name}\0${shas[i]}\n`).join("")).slice(0, 16));
    mkdirSync(dir, { recursive: true });
    writeOnce(join(dir, "provenance.json"), `${JSON.stringify({ files: files.map((f, i) => ({ name: f.name, sha256: shas[i], source: f.source })), writtenAt: new Date().toISOString() }, null, 2)}\n`, 0o444);
    const targets = files.map((f) => join(dir, f.name));
    files.forEach((f, i) => { if (!existsSync(targets[i]!)) writeOnce(targets[i]!, f.bytes, 0o444); });
    const changed = targets.filter((t, i) => sha256Of(readFileSync(t)) !== shas[i]);
    if (changed.length) {
      log(`launch helpers kept on the package path: ${changed.join(", ")} changed locally (left as is)`);
      return [...sources];
    }
    return targets;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT" || !sources.some((s) => !existsSync(s))) log(`launch helpers kept on the package path: ${(e as Error).message}`);
    return [...sources];
  }
}

export function durableLaunchAsset(source: string, home: string, log?: (msg: string) => void): string {
  return durableLaunchAssets([source], home, log)[0]!;
}
