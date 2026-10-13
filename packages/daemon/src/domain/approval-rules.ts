import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix } from "node:path";
import { createRequire } from "node:module";
import { maskSecrets } from "./credential-mask.js";

export type RuleEffect = "allow" | "deny";

export interface ApprovalRule {
  effect: RuleEffect;
  match: string;
  seats?: string;
  note?: string;
  /** The match's argument is one literal input, compared whole: no glob, no splitting, no wildcard. */
  exact?: boolean;
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
    && (r.seats === undefined || typeof r.seats === "string") && (r.note === undefined || typeof r.note === "string")
    && (r.exact === undefined || (typeof r.exact === "boolean" && (!r.exact || parseMatch(r.match)!.arg !== null)));
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

/** The rules a new home starts with: read-only inspection, git read verbs, test runners and the rig CLI,
 *  plus the safety denies. Written only when the home has no rules file; a user's file is never touched. */
export const DEFAULT_APPROVAL_RULES: readonly ApprovalRule[] = [
  ...["Read", "Glob", "Grep", "Skill"].map((match) => ({ effect: "allow" as const, match })),
  ...["ls", "cat", "head", "tail", "wc", "grep", "jq", "sqlite3 -readonly -safe", "pwd",
    "git status", "git log", "git diff", "git show", "git branch", "git rev-parse", "git fetch", "git blame", "git ls-files",
    "npm test", "npm run test", "pnpm test", "pnpm run test", "npx vitest", "npx jest", "pytest", "go test", "cargo test", "make test",
    "rig"].map((command) => ({ effect: "allow" as const, match: `Bash(${command} *)` })),
  { effect: "deny", match: "Bash(rig send *--dangerously-interact*)", note: "a seat never drives another seat's prompt" },
  { effect: "deny", match: "Bash(git push *--force*)", note: "no force-push" },
  { effect: "deny", match: "Bash(git push *-f *)", note: "no force-push" },
  { effect: "deny", match: "Bash(git push * main)", note: "merges go through review" },
  { effect: "deny", match: "Bash(git push * master)", note: "merges go through review" },
  { effect: "deny", match: "Bash(git *--upload-pack*)", note: "runs a local command" },
  { effect: "deny", match: "Bash(git *--output*)", note: "writes arbitrary files" },
  { effect: "deny", match: "Bash(git -c *)", note: "config overrides can run commands" },
  { effect: "deny", match: "Bash(git *--ext-diff*)", note: "runs an external diff program" },
  ...["/", "~", "~/", "$HOME"].map((target) => ({ effect: "deny" as const, match: `Bash(rm -rf ${target})`, note: "never delete home or root" })),
];

/** Commands that run another command, whose second word does not bound what they do, or that destroy. */
const WRAPPERS = new Set(["cd", "env", "sudo", "timeout", "nice", "nohup", "time", "xargs", "watch", "command", "exec", "find",
  "rm", "rmdir", "kill", "pkill", "killall", "mv", "chmod", "chown", "dd"]);

const SUBCOMMAND = /^[a-z][a-z0-9-]*$/;

/** The command's fixed start: its executable, then up to two subcommand words (`gh pr view`), or one file it
 *  runs or reads (`bash /x.sh`, `cat notes.md`). Stops at the first option or argument-looking word. */
function fixedStart(words: readonly string[]): string[] {
  const fixed = [words[0]!];
  for (const word of words.slice(1, 3)) {
    if (SUBCOMMAND.test(word)) { fixed.push(word); continue; }
    const file = !word.startsWith("-") && PLAIN_WORD.test(word) && /[./]/.test(word) && /[a-z]/i.test(word);
    if (fixed.length === 1 && file) fixed.push(word);
    break;
  }
  return fixed;
}

/** A single plain Bash command's fixed start followed by " *" for the varying rest, or null when the command
 *  has no start that bounds what it does (a wrapper, a destructive verb, a bare executable, a compound). */
function wildcardRule(command: string): string | null {
  const parts = plain.plainParts(command);
  if (!parts || parts.length !== 1 || !allowable(parts[0]!)) return null;
  const words = parts[0]!.split(" ");
  const fixed = fixedStart(words);
  // Two fixed words (a script, a subcommand): a bare executable would allow everything it can do.
  if (WRAPPERS.has(words[0]!) || fixed.length < 2) return null;
  return `Bash(${fixed.join(" ")} *)`;
}

/** The literal an exact rule compares: the whole command, else the tool's path (normalized) or other input. */
function exactValue(toolInput: unknown): string {
  const command = commandOf(toolInput);
  if (command !== null) return command.trim();
  const arg = argOf(toolInput);
  return arg.path ? posix.normalize(expandHome(arg.value)) : arg.value.trim();
}

export type AlwaysRule = { match: string; exact: boolean } | { refused: string };

/** The rule an "Always approve/deny" click saves for this request: a plain Bash command's fixed start with a
 *  wildcard for the rest, else the exact input. A rule that would carry a credential is never saved. */
export function alwaysRuleFor(toolName: string, toolInput: unknown): AlwaysRule {
  const wildcard = toolName === "Bash" && commandOf(toolInput) !== null ? wildcardRule(commandOf(toolInput)!) : null;
  const value = exactValue(toolInput);
  const rule = wildcard ? { match: wildcard, exact: false } : { match: `${toolName}(${value})`, exact: true };
  if (maskSecrets(rule.match) !== rule.match) return { refused: "it carries a credential" };
  const arg = commandOf(toolInput) === null ? argOf(toolInput) : null;
  if (arg?.path && arg.value.split("/").includes("..")) return { refused: "its path climbs with \"..\"" };
  return value && isValidRule({ effect: "allow", ...rule }) ? rule : { refused: "this request has no input a rule can name" };
}

/** Saves a rule from an Always click: added once, scoped to `seats`, never rewriting other rules. */
export function saveAlwaysRule(home: string, rule: ApprovalRule): void {
  if (!isValidRule(rule)) throw new Error(`not a rule: ${JSON.stringify(rule)}`);
  const rules = readApprovalRules(home);
  if (rules.some((r) => r.effect === rule.effect && r.match === rule.match && r.seats === rule.seats && !!r.exact === !!rule.exact)) return;
  writeApprovalRules(home, [...rules, rule]);
}

/** Writes the default rules when the home has none; returns whether it wrote them. */
export function seedApprovalRules(home: string): boolean {
  if (existsSync(approvalRulesPath(home))) return false;
  writeApprovalRules(home, DEFAULT_APPROVAL_RULES);
  return true;
}

export function writeApprovalRules(home: string, rules: readonly ApprovalRule[]): void {
  const invalid = rules.findIndex((r) => !isValidRule(r));
  if (invalid !== -1) throw new Error(`rule ${invalid + 1} is invalid: ${JSON.stringify(rules[invalid])}`);
  const path = approvalRulesPath(home);
  writeFileSync(`${path}.tmp`, `${JSON.stringify({ rules }, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
}

function parseMatch(match: string): { tool: string; arg: string | null; literal: string | null } | null {
  const m = /^([^()\s]+)(?:\((.*)\))?$/s.exec(match.trim());
  if (!m || (m[2] !== undefined && !m[2].trim())) return null;
  return { tool: m[1]!, arg: m[2] === undefined ? null : m[2].trim().replace(/:\*$/, " *"), literal: m[2] === undefined ? null : m[2].trim() };
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

interface PlainCommand {
  parse: (command: string) => Array<Array<{ text: string; quoted: boolean }>> | null;
  plainParts: (command: string) => string[] | null;
}
const plain = createRequire(import.meta.url)("../../assets/plugins/openrig-core/hooks/scripts/plain-command.cjs") as PlainCommand;

const PLAIN_WORD = /^[\w\-.:@%+,/=]+$/;

/** An allow rule takes a simple part whose words are plain or quoted literals: no glob, tilde,
 *  assignment or executable path; a cd takes one plain directory and never climbs with "..". */
function allowable(part: string): boolean {
  const words = plain.parse(part);
  if (!words || words.length !== 1) return false;
  const [first, ...args] = words[0]!;
  if (!first || first.quoted || !PLAIN_WORD.test(first.text) || /[=/]/.test(first.text)) return false;
  // A partly quoted word's unquoted text still expands (braces, globs, a leading ~): it must be plain too.
  if (!args.every((w) => { const bare = w.text.replace(/'[^']*'|"[^"]*"/g, ""); return bare === "" || PLAIN_WORD.test(bare); })) return false;
  if (first.text !== "cd") return true;
  return args.length === 1 && !args[0]!.quoted && !args[0]!.text.split("/").includes("..");
}

function hits(rule: ApprovalRule, req: RuleRequest): boolean {
  if (rule.seats && !globMatches(rule.seats, req.sessionName)) return false;
  const match = parseMatch(rule.match)!;
  if (rule.exact) {
    // A path that climbs with ".." may reach another file through a symlink: an exact allow never takes one.
    const arg = commandOf(req.toolInput) === null ? argOf(req.toolInput) : null;
    if (rule.effect === "allow" && arg?.path && arg.value.split("/").includes("..")) return false;
    return match.tool === req.toolName && match.literal === exactValue(req.toolInput);
  }
  if (!globMatches(match.tool, req.toolName)) return false;
  if (match.arg === null) return true;
  const command = commandOf(req.toolInput);
  // An MCP exec tool's `call <name> <json>`: the rule names the call; its JSON arguments are data.
  const call = req.toolName.startsWith("mcp__") && command !== null ? /^call\s+([\w.:-]+)(?:\s|$)/.exec(command.trim()) : null;
  if (call) {
    const named = /^call\s+([\w.:*-]+)(?:\s+\*)?$/.exec(match.arg);
    return !!named && globMatches(named[1]!, call[1]!);
  }
  if (command === null) {
    const arg = argOf(req.toolInput);
    if (!arg.path) return globMatches(match.arg, arg.value);
    if (rule.effect === "allow" && arg.value.split("/").includes("..")) return false;
    return globMatches(match.arg, posix.normalize(expandHome(arg.value)), true);
  }
  if (rule.effect === "deny") return commandSegments(command).some((s) => globMatches(match.arg!, s));
  return allowable(command) && globMatches(match.arg, command);
}

/** Deny wins over allow; no hit leaves the request to the human. A command is allowed only when it is
 *  simple (the guard's definition) and every part of it, a cd included, matches an allow rule. */
export function ruleDecision(rules: readonly ApprovalRule[], req: RuleRequest): RuleHit | null {
  const deny = rules.find((r) => r.effect === "deny" && hits(r, req));
  if (deny) return { effect: "deny", rule: deny };
  const exact = rules.find((r) => r.effect === "allow" && r.exact && hits(r, req));
  if (exact) return { effect: "allow", rule: exact };
  const allowOf = (r: RuleRequest) => rules.find((rule) => rule.effect === "allow" && hits(rule, r));
  const command = commandOf(req.toolInput);
  if (command === null || (req.toolName.startsWith("mcp__") && /^call\s+[\w.:-]+(?:\s|$)/.test(command.trim()))) {
    const allow = allowOf(req);
    return allow ? { effect: "allow", rule: allow } : null;
  }
  const parts = plain.plainParts(command);
  if (!parts) return null;
  const covering = parts.map((p) => allowOf({ ...req, toolInput: { command: p } }));
  return covering.every(Boolean) ? { effect: "allow", rule: covering[covering.length - 1]! } : null;
}

const appliesTo = (r: ApprovalRule, sessionName: string | null) => !r.seats || (sessionName !== null && globMatches(r.seats, sessionName));

/** One seat's allow and deny rules in Claude's own permission syntax, so its runtime applies them before any
 *  prompt or classifier. Claude reads a filesystem-absolute path as //path, and ignores an MCP rule with a
 *  pattern (the daemon still applies those). */
export function claudePermissionRules(rules: readonly ApprovalRule[], sessionName: string | null): { allow: string[]; deny: string[] } {
  const native = (effect: RuleEffect) => rules.filter((r) => r.effect === effect && appliesTo(r, sessionName)).flatMap(claudeRule);
  return { allow: native("allow"), deny: native("deny") };
}

/** A rule in Claude's syntax, or none when Claude cannot say it: an MCP pattern, or an exact input Claude would
 *  read as a glob (`*`, `?`, `[...]`, an escape), that spans lines or nests parentheses, or that is no command or
 *  path. The daemon still applies those. */
function claudeRule(r: ApprovalRule): string[] {
  const m = parseMatch(r.match)!;
  if (m.arg === null) return [m.tool];
  if (m.tool.startsWith("mcp__")) return [];
  if (r.exact && (/[*?[\]\\\n()]/.test(m.literal!) || !(m.tool === "Bash" || m.literal!.startsWith("/")))) return [];
  return [`${m.tool}(${m.tool !== "Bash" && /^\/(?!\/)/.test(m.arg) ? `/${m.arg}` : m.arg})`];
}

/** Codex rules are literal token prefixes: a Bash pattern of plain words, optionally ending in " *". */
function codexPrefix(match: string): string[] | null {
  const m = parseMatch(match);
  if (!m || m.tool !== "Bash" || m.arg === null) return null;
  const words = m.arg.replace(/ \*$/, "").split(" ");
  return words.every((w) => /^[\w\-.:@%+,/=]+$/.test(w)) ? words : null;
}

export const CODEX_RULES_FILE = "openrig.rules";

/** The deny rules every seat shares, as Codex execpolicy `forbidden`. A Codex `allow` would run the command
 *  outside Codex's sandbox without asking, so allow rules stay with the daemon's prompt-time check. Codex
 *  reads every *.rules file in its home for every session, so a rule scoped to some seats, or a pattern Codex
 *  cannot express as a literal prefix, stays with the daemon too. */
export function codexRulesText(rules: readonly ApprovalRule[]): string {
  const lines = rules.filter((r) => r.effect === "deny" && !r.exact && (!r.seats || r.seats === "*")).flatMap((r) => {
    const prefix = codexPrefix(r.match);
    if (!prefix) return [];
    const note = r.note ? `, justification=${JSON.stringify(r.note)}` : "";
    return [`prefix_rule(pattern=${JSON.stringify(prefix)}, decision="forbidden"${note})`];
  });
  return `# Written by OpenRig from ${APPROVAL_RULES_FILE} at each Codex launch; edits here are replaced.\n${lines.join("\n")}\n`;
}

/** Keeps `<codexHome>/rules/openrig.rules` equal to the shared rules; never touches any other rules file. */
export function projectCodexRules(home: string, codexHome: string): void {
  const dir = join(codexHome, "rules");
  const path = join(dir, CODEX_RULES_FILE);
  const text = codexRulesText(readApprovalRules(home));
  try { if (readFileSync(path, "utf8") === text) return; } catch { /* first write */ }
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${path}.tmp`, text);
  renameSync(`${path}.tmp`, path);
}

export function claudeDenyRules(rules: readonly ApprovalRule[], sessionName: string | null): string[] {
  return rules.filter((r) => r.effect === "deny" && appliesTo(r, sessionName)).flatMap(claudeRule);
}
