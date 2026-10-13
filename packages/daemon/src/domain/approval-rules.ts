import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

function globRegex(glob: string): RegExp {
  const expanded = glob.replace(/^~(?=\/|$)/, homedir());
  const body = expanded.split(/(\*+)/).map((part) => part.startsWith("*") ? ".*" : part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("");
  return new RegExp(`^${body.replace(/ \.\*$/, "(?: .*)?")}$`, "s");
}

const globMatches = (glob: string, value: string) => globRegex(glob).test(value);

function commandOf(toolInput: unknown): string | null {
  const command = (toolInput as { command?: unknown } | null)?.command;
  if (typeof command === "string") return command;
  if (Array.isArray(command) && command.every((c) => typeof c === "string")) return command.join(" ");
  return null;
}

function argOf(toolInput: unknown): string {
  const input = (toolInput ?? {}) as Record<string, unknown>;
  for (const key of ["file_path", "notebook_path", "path", "url", "query", "pattern"]) {
    if (typeof input[key] === "string") return input[key] as string;
  }
  return JSON.stringify(toolInput ?? {});
}

function stripLaunchers(segment: string): string {
  let s = segment.trim();
  for (let prev = ""; prev !== s;) {
    prev = s;
    s = s.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, "").replace(/^(?:sudo|env|command|exec|nohup|time)\s+/, "");
  }
  return s.replace(/^\S*\//, "");
}

const COMPOUND = /[;&|\n`$()<>]/;

/** Every simple command a deny rule must see, wherever it sits in a compound command. */
function commandSegments(command: string): string[] {
  return command.split(/[;&|\n`()<>]+|\$\(/).map(stripLaunchers).filter(Boolean);
}

function hits(rule: ApprovalRule, req: RuleRequest): boolean {
  if (rule.seats && !globMatches(rule.seats, req.sessionName)) return false;
  const match = parseMatch(rule.match)!;
  if (!globMatches(match.tool, req.toolName)) return false;
  if (match.arg === null) return true;
  const command = commandOf(req.toolInput);
  if (command === null) return globMatches(match.arg, argOf(req.toolInput));
  if (rule.effect === "deny") return commandSegments(command).some((s) => globMatches(match.arg!, s));
  return !COMPOUND.test(command) && globMatches(match.arg, stripLaunchers(command));
}

/** Deny wins over allow; no hit leaves the request to the human. A compound or expanding command is never allowed by rule. */
export function ruleDecision(rules: readonly ApprovalRule[], req: RuleRequest): RuleHit | null {
  const deny = rules.find((r) => r.effect === "deny" && hits(r, req));
  if (deny) return { effect: "deny", rule: deny };
  const allow = rules.find((r) => r.effect === "allow" && hits(r, req));
  return allow ? { effect: "allow", rule: allow } : null;
}

/** The deny rules for one seat, in Claude's own permission syntax, so its runtime refuses them even without the daemon. */
export function claudeDenyRules(rules: readonly ApprovalRule[], sessionName: string | null): string[] {
  return rules.filter((r) => r.effect === "deny" && (!r.seats || (sessionName !== null && globMatches(r.seats, sessionName))))
    .map((r) => { const m = parseMatch(r.match)!; return m.arg === null ? m.tool : `${m.tool}(${m.arg})`; });
}
