import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const SECRET_FILE = "seat-token-secret";

/** The daemon-only key seat tokens derive from (0600, never put in a seat's environment). */
export function ensureSeatTokenSecret(home: string): string {
  const file = path.join(home, SECRET_FILE);
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (existing) return existing;
  } catch { /* first use */ }
  const secret = randomBytes(32).toString("hex");
  mkdirSync(home, { recursive: true });
  writeFileSync(file, secret, { mode: 0o600 });
  chmodSync(file, 0o600);
  return secret;
}

/** A seat's own token: bound to its node, session name and occupant generation. */
export function seatToken(secret: string, nodeId: string, sessionName: string, generation: string): string {
  return createHmac("sha256", secret).update(`${nodeId}|${sessionName}|${generation}`).digest("hex");
}

export function seatTokenMatches(expected: string, presented: string | null | undefined): boolean {
  if (!presented || presented.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(presented));
}

/** The token proves the seat's live occupant: the current generation's, or the latest launch's when
 *  only adopts followed it and the seat's live session still carries that launch generation (the same
 *  surviving process, adopted under a new generation). */
export function seatTokenProvesOccupant(input: {
  secret: string; nodeId: string; sessionName: string; presented: string | null | undefined;
  current: string | undefined; launched: string | undefined; liveSessionGeneration: string | undefined;
}): boolean {
  const matches = (generation: string) => seatTokenMatches(seatToken(input.secret, input.nodeId, input.sessionName, generation), input.presented);
  if (input.current && matches(input.current)) return true;
  return !!input.launched && input.liveSessionGeneration === input.launched && matches(input.launched);
}

/** OPENRIG_SEAT_TOKEN for a launch, when the instance home and generation are known. */
export function seatTokenEnv(home: string | undefined, nodeId: string, sessionName: string | undefined, generation: string | null | undefined): { OPENRIG_SEAT_TOKEN?: string } {
  if (!home || !sessionName || !generation) return {};
  try {
    return { OPENRIG_SEAT_TOKEN: seatToken(ensureSeatTokenSecret(path.resolve(home)), nodeId, sessionName, generation) };
  } catch {
    return {};
  }
}
