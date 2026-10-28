/**
 * The matcher behind `policies.autoApprove`. Entries are strings:
 *
 * - `"bash"` — a bare tool name approves EVERY call of that tool.
 * - `"bash:git *"` — a `tool:pattern` entry approves only calls of `tool`
 *   whose ACTION TEXT matches the glob (`*` = any run, `?` = one char,
 *   everything else literal, case-sensitive, anchored).
 *
 * The action text of a call is its command/script field(s) (`command`,
 * `cmd`, `script`, `code`, `shell`, `sql`, `query` — same heuristic as the
 * Jev gate's complexity check) when the input has any, so `bash:git status`
 * gates the command line; tools without command fields match the pattern
 * against the input's string values, so `send_message:Hello*` gates the
 * payload; an input with neither matches its serialised JSON. The action
 * text is data, not instructions: a pattern only ever matches text, and a
 * crafted command cannot escape its own entry.
 *
 * Floors still outrank the list — the hook checks `isApprovalFloor` before
 * consulting this matcher, so no entry (bare or patterned) ever waves a
 * first-use credential/connector or `secret_request` call through.
 */
import type { ApprovalRequest } from "./approvals.ts";

/** Input fields that hold a command or script (same heuristic as jev-gate). */
const COMMAND_FIELDS = /^(command|cmd|script|code|shell|sql|query)$/i;

/** Depth cap mirrors the Jev gate's input walks. */
const MAX_DEPTH = 4;

/** The texts a `tool:pattern` entry matches: command fields, else string values, else the serialised input. */
export const actionTextsOf = (input: unknown): string[] => {
  const texts: string[] = [];
  const walk = (value: unknown, depth: number): void => {
    if (depth > MAX_DEPTH || value === null || typeof value !== "object") return;
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (typeof inner === "string" && COMMAND_FIELDS.test(key)) texts.push(inner);
      else walk(inner, depth + 1);
    }
  };
  walk(input, 0);
  if (texts.length === 0) {
    const leaves = (value: unknown, depth: number): void => {
      if (depth > MAX_DEPTH) return;
      if (typeof value === "string") texts.push(value);
      else if (value !== null && typeof value === "object")
        for (const inner of Object.values(value as Record<string, unknown>))
          leaves(inner, depth + 1);
    };
    leaves(input, 0);
  }
  if (texts.length === 0) {
    try {
      texts.push(JSON.stringify(input) ?? "");
    } catch {
      texts.push("");
    }
  }
  return texts;
};

/** Glob → RegExp: `*` = any run, `?` = one char, everything else literal; anchored both ends. */
export const globToRegExp = (glob: string): RegExp => {
  const source = [...glob]
    .map((ch) => {
      if (ch === "*") return ".*";
      if (ch === "?") return ".";
      return ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  return new RegExp(`^${source}$`);
};

/** Split an entry into its tool and optional pattern ("bash" → bash; "bash:git *" → bash + "git *"). */
export const parseAutoApproveEntry = (entry: string): { tool: string; pattern?: string } => {
  const i = entry.indexOf(":");
  return i === -1 ? { tool: entry } : { tool: entry.slice(0, i), pattern: entry.slice(i + 1) };
};

/**
 * True when some entry approves this call. A bare name approves every call
 * of the tool; a pattern must match the action text (any command field, or
 * the serialised input when there is none). Safe by default: an empty
 * pattern (`"tool:"`) matches only an empty action text, so it approves
 * nothing in practice.
 */
export const autoApproves = (entries: readonly string[], request: ApprovalRequest): boolean =>
  entries.some((entry) => {
    const { tool, pattern } = parseAutoApproveEntry(entry);
    if (tool !== request.name) return false;
    if (pattern === undefined) return true;
    const re = globToRegExp(pattern);
    return actionTextsOf(request.input).some((text) => re.test(text));
  });
