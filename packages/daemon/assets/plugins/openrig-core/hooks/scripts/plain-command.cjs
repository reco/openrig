"use strict";

// One definition of a simple command, shared by the Bash PreToolUse guard and the approval-rule matcher.
// A command is a chain of parts joined by &&, ||, ; or |; a part is words separated by single spaces;
// a word is unquoted text or a quoted literal: single quotes, or double quotes with no $, ` or \ inside.

const OPERATORS = ["&&", "||", ";", "|"];
const SHELL_KEYWORDS = new Set(["for", "while", "until", "if", "then", "else", "elif", "fi", "case", "esac", "do", "done", "select", "function", "{", "}", "!"]);

/** The command's parts split at top-level operators, each as its words; null when quoting is unbalanced
 *  or a double-quoted string expands ($, ` or \ inside). */
function parse(command) {
  const parts = [];
  let words = [], word = null, i = 0;
  const endWord = () => { if (word !== null) words.push(word); word = null; };
  const endPart = () => { endWord(); parts.push(words); words = []; };
  while (i < command.length) {
    const c = command[i];
    if (c === "'" || c === '"') {
      const close = command.indexOf(c, i + 1);
      if (close === -1) return null;
      const inner = command.slice(i + 1, close);
      if (c === '"' && /[$`\\]/.test(inner)) return null;
      word = word ?? { text: "", quoted: false };
      word.text += command.slice(i, close + 1);
      word.quoted = true;
      i = close + 1;
      continue;
    }
    const op = OPERATORS.find((o) => command.startsWith(o, i));
    if (op) { endPart(); parts.push(op); i += op.length; continue; }
    if (c === " ") { endWord(); i++; continue; }
    word = word ?? { text: "", quoted: false };
    word.text += c;
    i++;
  }
  endPart();
  const chain = parts.filter((p) => typeof p !== "string");
  return chain.every((p) => p.length > 0) ? chain : null;
}

/** Unquoted characters that change what a command does beyond running its words. */
const EXPANDING = /[$`\\()<>&\t\n\r]/;

/** Why a command is not simple, or null when it is (the guard's test). */
function complexity(command) {
  if (!command.trim()) return "an empty command";
  if (/\n/.test(command.replace(/'[^']*'/g, ""))) return "several lines";
  const chain = parse(command.trim());
  if (!chain) return "unbalanced or expanding quotes";
  for (const words of chain) {
    if (SHELL_KEYWORDS.has(words[0].text)) return `the shell keyword ${words[0].text}`;
    for (const w of words) {
      const bare = w.text.replace(/'[^']*'|"[^"]*"/g, "");
      if (EXPANDING.test(bare)) return /[<>]/.test(bare) ? "a redirect" : /&/.test(bare) ? "a background &" : "a substitution, variable or escape";
    }
  }
  return null;
}

/** The plain parts of a command (each as its text), or null when it is not a simple command. */
function plainParts(command) {
  if (complexity(command)) return null;
  return parse(command.trim()).map((words) => words.map((w) => w.text).join(" "));
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Variables that change which program runs or what it loads at startup. */
const RUN_CHANGING = /^(?:PATH|NODE_OPTIONS|NODE_PATH|LD_\w*|DYLD_\w*|BASH_ENV|ENV|PYTHONPATH|PYTHONSTARTUP|PERL5LIB|RUBYOPT|GIT_\w*|SHELL|IFS|PROMPT_COMMAND)=/;

/** A part's words after its leading NAME=value assignments; null when one of them changes what runs. */
function afterAssignments(words) {
  let i = 0;
  for (; i < words.length - 1 && ASSIGNMENT.test(words[i].text); i++) if (RUN_CHANGING.test(words[i].text)) return null;
  return words.slice(i);
}

module.exports = { parse, complexity, plainParts, afterAssignments };
