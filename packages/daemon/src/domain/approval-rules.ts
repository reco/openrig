import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix } from "node:path";

export type RuleEffect = "allow" | "deny";

export interface ApprovalRule {
  effect: RuleEffect;
  match: string;
  seats?: string;
  note?: string;
}

export interface RuleRequest {
  sessionName: string;
  toolName: string;
  toolInput: unknown;
}

export interface RuleHit {
  effect: RuleEffect;
  rule: ApprovalRule;
}

export const APPROVAL_RULES_FILE = "approval-rules.json";

export function approvalRulesPath(home: string): string {
  return join(home, APPROVAL_RULES_FILE);
}

export function isValidRule(rule: unknown): rule is ApprovalRule {
  const r = rule as Partial<ApprovalRule> | null;
  return !!r && (r.effect === "allow" || r.effect === "deny") && typeof r.match === "string" && parseMatch(r.match) !== null
    && (r.seats === undefined || typeof r.seats === "string") && (r.note === undefined || typeof r.note === "string");
}

export function readApprovalRules(home: string): ApprovalRule[] {
  let raw: string;
  try { raw = readFileSync(approvalRulesPath(home), "utf8"); } catch { return []; }
  const rules = (JSON.parse(raw) as { rules?: unknown }).rules;
  if (!Array.isArray(rules)) throw new Error(`${APPROVAL_RULES_FILE} has no "rules" list`);
  const invalid = rules.findIndex((r) => !isValidRule(r));
  if (invalid !== -1) throw new Error(`${APPROVAL_RULES_FILE} rule ${invalid + 1} is invalid: ${JSON.stringify(rules[invalid])}`);
  return rules as ApprovalRule[];
}

export function writeApprovalRules(home: string, rules: readonly ApprovalRule[]): void {
  const invalid = rules.findIndex((r) => !isValidRule(r));
  if (invalid !== -1) throw new Error(`rule ${invalid + 1} is invalid: ${JSON.stringify(rules[invalid])}`);
  const path = approvalRulesPath(home);
  writeFileSync(`${path}.tmp`, `${JSON.stringify({ rules }, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
}

function parseMatch(match: string): { tool: string; arg: string | null } | null {
  const m = /^([^()\s]+)(?:\((.*)\))?$/s.exec(match.trim());
  if (!m || (m[2] !== undefined && !m[2].trim())) return null;
  return { tool: m[1]!, arg: m[2] === undefined ? null : m[2].trim().replace(/:\*$/, " *") };
}

function globRegex(glob: string, path = false): RegExp {
  const expanded = path ? expandHome(glob.replace(/^\/\//, "/")).replace(/\/\*\*\//g, "/\u0000") : glob;
  const body = expanded.split(/(\*+|\u0000)/).map((part) => part === "\u0000" ? "(?:.*/)?" : part.startsWith("*") ? (path && part === "*" ? "[^/]*" : ".*") : part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("");
  return new RegExp(`^${body.replace(/ \.\*$/, "(?: .*)?")}$`, "s");
}

const globMatches = (glob: string, value: string, path = false) => globRegex(glob, path).test(value);
const expandHome = (p: string) => p.replace(/^~(?=\/|$)/, homedir());

function commandOf(toolInput: unknown): string | null {
  const command = (toolInput as { command?: unknown } | null)?.command;
  if (typeof command === "string") return command;
  if (Array.isArray(command) && command.every((c) => typeof c === "string")) return command.join(" ");
  return null;
}

const PATH_KEYS = ["file_path", "notebook_path", "path"];

function argOf(toolInput: unknown): { value: string; path: boolean } {
  const input = (toolInput ?? {}) as Record<string, unknown>;
  for (const key of [...PATH_KEYS, "url", "query", "pattern"]) {
    if (typeof input[key] === "string") return { value: input[key] as string, path: PATH_KEYS.includes(key) };
  }
  return { value: JSON.stringify(toolInput ?? {}), path: false };
}

/** A deny rule sees through quoting, spacing, assignments, wrappers and the executable's directory. */
function denyForm(segment: string): string {
  let s = segment.replace(/['"\\]/g, "").replace(/\s+/g, " ").trim();
  for (let prev = ""; prev !== s;) {
    prev = s;
    s = s.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, "").replace(/^(?:sudo|env|command|exec|nohup|time|nice)\s+/, "");
  }
  return s.replace(/^\S*\//, "");
}

/** Every simple command a deny rule must see, wherever it sits in a compound command. */
function commandSegments(command: string): string[] {
  return command.split(/[;&|\n`(){}<>]+|\$\(/).map(denyForm).filter(Boolean);
}

/** An allow rule takes only plain words, single-spaced: no quoting, expansion, operators, assignment or executable path. */
const PLAIN_COMMAND = /^[\w\-.:@%+,/=]+(?: [\w\-.:@%+,/=]+)*$/;
const allowable = (command: string) => PLAIN_COMMAND.test(command) && !/[=/]/.test(command.split(" ")[0]!)
  && !(command.startsWith("cd ") && (!CHANGE_DIR.test(command) || command.split(/[ /]/).includes("..")));

function hits(rule: ApprovalRule, req: RuleRequest): boolean {
  if (rule.seats && !globMatches(rule.seats, req.sessionName)) return false;
  const match = parseMatch(rule.match)!;
  if (!globMatches(match.tool, req.toolName)) return false;
  if (match.arg === null) return true;
  const command = commandOf(req.toolInput);
  if (command === null) {
    const arg = argOf(req.toolInput);
    if (!arg.path) return globMatches(match.arg, arg.value);
    if (rule.effect === "allow" && arg.value.split("/").includes("..")) return false;
    return globMatches(match.arg, posix.normalize(expandHome(arg.value)), true);
  }
  if (rule.effect === "deny") return commandSegments(command).some((s) => globMatches(match.arg!, s));
  return allowable(command) && globMatches(match.arg, command);
}

const OPERATOR = /\s*(?:&&|\|\||;|\|)\s*/;
const CHANGE_DIR = /^cd [\w\-.:@%+,/=]+$/;

/** The plain commands of a command chained only with &&, ||, ; or |, or null when any part is not plain. */
function plainParts(command: string): string[] | null {
  if (!/(?:&&|\|\||;|\|)/.test(command)) return null;
  const parts = command.trim().split(OPERATOR);
  return parts.every(allowable) ? parts : null;
}

/** Deny wins over allow; no hit leaves the request to the human. A plain command is allowed by a matching rule;
 *  a chain of plain commands only when every command in it is, a cd included (and a cd never climbs with ..). */
export function ruleDecision(rules: readonly ApprovalRule[], req: RuleRequest): RuleHit | null {
  const deny = rules.find((r) => r.effect === "deny" && hits(r, req));
  if (deny) return { effect: "deny", rule: deny };
  const allowOf = (r: RuleRequest) => rules.find((rule) => rule.effect === "allow" && hits(rule, r));
  const command = commandOf(req.toolInput);
  const parts = command === null ? null : plainParts(command);
  if (parts) {
    const covering = parts.map((p) => allowOf({ ...req, toolInput: { command: p } }));
    return covering.length && covering.every(Boolean) ? { effect: "allow", rule: covering[covering.length - 1]! } : null;
  }
  const allow = allowOf(req);
  return allow ? { effect: "allow", rule: allow } : null;
}

/** The deny rules for one seat in Claude's own permission syntax, so its runtime refuses them even without the daemon.
 *  Claude reads a filesystem-absolute path as //path, and ignores an MCP rule with a pattern (the daemon still applies it). */
export function claudeDenyRules(rules: readonly ApprovalRule[], sessionName: string | null): string[] {
  return rules.filter((r) => r.effect === "deny" && (!r.seats || (sessionName !== null && globMatches(r.seats, sessionName))))
    .flatMap((r) => {
      const m = parseMatch(r.match)!;
      if (m.arg === null) return [m.tool];
      if (m.tool.startsWith("mcp__")) return [];
      return [`${m.tool}(${m.tool !== "Bash" && /^\/(?!\/)/.test(m.arg) ? `/${m.arg}` : m.arg})`];
    });
}
