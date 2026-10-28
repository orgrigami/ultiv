/**
 * The matcher behind `policies.autoApprove`. Entries are strings:
 *
 * - `"bash"` — a bare tool name approves EVERY call of that tool. This is
 *   the owner's explicit whole-tool grant: no sub-action checks run on it.
 * - `"bash:git *"` — a `tool:pattern` entry approves only calls of `tool`
 *   whose ACTION TEXT matches the glob (`*` = any run, `?` = one char, of
 *   text carrying NO `;`, `&`, `|`, newline, CR or backtick — a wildcard
 *   cannot cross a command boundary; everything else literal, case-
 *   sensitive, anchored). Tool names are colon-free, so the first `:`
 *   splits. On top of that, a pattern is narrower than a bare name, never
 *   looser: if ANY candidate text of the call carries a chaining or
 *   substitution operator, the whole call is refused; a SHELL text that
 *   carries one of git's/shell's escape hatches (`-c`, `--exec-path`,
 *   `--upload-pack`, `!`) is refused too; and a call the Jev gate's
 *   destructive check flags falls through to the normal gate. A refused
 *   call goes to Jev or the owner's card, as the approval mode dictates.
 *
 * The action text of a call is its command/script field(s) (`command`,
 * `cmd`, `script`, `code`, `shell`, `sql`, `query` — same heuristic as the
 * Jev gate's complexity check; a string ARRAY under such a key is joined
 * into one command line) when the input has any — these are SHELL texts,
 * held to the stricter escape-hatch rule. Tools without command fields
 * match the pattern against the input's TOP-LEVEL string values, so
 * `send_message:Hello*` gates the payload; an input with neither matches
 * its serialised JSON (keys match there too — keep rules off key-shaped
 * globs). The action text is data, not instructions: a pattern only ever
 * matches text.
 *
 * Floors still outrank the list — the hook checks `isApprovalFloor` before
 * consulting this matcher, so no entry (bare or patterned) ever waves a
 * first-use credential/connector or `secret_request` call through.
 */
import type { ApprovalRequest } from "./approvals.ts";
import { CHAIN_OPS, SUBSHELL_OR_HEREDOC, SUBSTITUTION, destructiveOf } from "./jev-gate.ts";

/** Input fields that hold a command or script (same heuristic as jev-gate). */
const COMMAND_FIELDS = /^(command|cmd|script|code|shell|sql|query)$/i;

/** Depth cap mirrors the Jev gate's input walks. */
const MAX_DEPTH = 4;

/** Command-boundary characters: no matched action text ever crosses one. */
const BOUNDARY_CHARS = ";\\n\\r&|`";
/** The `?` wildcard: one char that is not a boundary. */
const ONE_CHAR = `[^${BOUNDARY_CHARS}]`;
/** The `*` wildcard: any run of non-boundary chars. */
const RUN_OF_CHARS = `[^${BOUNDARY_CHARS}]*`;

/** Chaining, substitution or a newline/CR — no pattern may match a text carrying one. */
const UNSAFE_TEXT = new RegExp(
  `${CHAIN_OPS.source}|${SUBSTITUTION.source}|${SUBSHELL_OR_HEREDOC.source}|\\n|\\r`,
);

/**
 * Shell escape hatches on a SHELL text: git aliases (`git -c alias.x='!cmd'
 * runs arbitrary commands under a `git *` pattern`), git's exec/upload-pack
 * hooks, and `!`-prefixed heads that hide a destructive command from the
 * destructive regexes. A shell text carrying one is refused.
 */
const SHELL_ESCAPE = /(^|\s)-c(\s|$)|--exec-path|--upload-pack|!/;

/** One candidate action text; `shell` = it came from a command/script field. */
export interface ActionText {
  readonly text: string;
  readonly shell: boolean;
}

/**
 * The texts a `tool:pattern` entry matches: command fields (string or
 * string-array values) when present — flagged shell — else the input's
 * top-level string values, else the serialised input.
 */
export const actionTextsOf = (input: unknown): ActionText[] => {
  const texts: ActionText[] = [];
  const commands = (value: unknown, depth: number): void => {
    if (depth > MAX_DEPTH || value === null || typeof value !== "object") return;
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (COMMAND_FIELDS.test(key)) {
        if (typeof inner === "string") texts.push({ text: inner, shell: true });
        else if (Array.isArray(inner) && inner.every((part) => typeof part === "string"))
          texts.push({ text: (inner as string[]).join(" "), shell: true });
      } else commands(inner, depth + 1);
    }
  };
  commands(input, 0);
  if (texts.length === 0 && input !== null && typeof input === "object") {
    for (const inner of Object.values(input as Record<string, unknown>)) {
      if (typeof inner === "string") texts.push({ text: inner, shell: false });
    }
  }
  if (texts.length === 0) {
    try {
      texts.push({ text: JSON.stringify(input) ?? "", shell: false });
    } catch {
      texts.push({ text: "", shell: false });
    }
  }
  return texts;
};

/** Glob → RegExp: `*`/`?` stay inside one command's text, everything else literal; anchored. */
export const globToRegExp = (glob: string): RegExp => {
  const source = [...glob]
    .map((ch) => {
      if (ch === "*") return RUN_OF_CHARS;
      if (ch === "?") return ONE_CHAR;
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

/** How the list matches one call. */
export type AutoApproveMatch =
  | { readonly kind: "none" }
  /** A bare tool name matched — the owner's whole-tool grant, no sub-action checks. */
  | { readonly kind: "bare" }
  /**
   * A `tool:pattern` matched safely. `destructive` carries the Jev gate's
   * destructive read when the call also looks destructive — the hook
   * refuses these (fall through to Jev or the card); bare names ignore it.
   */
  | { readonly kind: "pattern"; readonly destructive: string | undefined };

/**
 * True when the whole call may be pattern-matched at all: NO candidate text
 * carries a chaining/substitution operator — a benign first field must not
 * approve a call whose second field chains a shell line.
 */
const matchable = (texts: readonly ActionText[]): boolean =>
  texts.every(({ text }) => !UNSAFE_TEXT.test(text));

/** True when some text matches the glob (call-wide safety already checked). */
const globMatch = (glob: string, texts: readonly ActionText[]): boolean => {
  const re = globToRegExp(glob);
  return texts.some(({ text, shell }) => re.test(text) && !(shell && SHELL_ESCAPE.test(text)));
};

/**
 * Match the list against one call. A bare name wins outright; a pattern
 * must match the action text (any command field, else top-level string
 * values, else the serialised input) without crossing a command boundary
 * or carrying a shell escape hatch, and is reported with the call's
 * destructive read for the hook to refuse. Safe by default: an empty
 * pattern (`"tool:"`) matches only an empty action text, so it approves
 * nothing in practice.
 */
export const matchAutoApprove = (
  entries: readonly string[],
  request: ApprovalRequest,
): AutoApproveMatch => {
  let bare = false;
  let pattern = false;
  const texts = actionTextsOf(request.input);
  const mayPattern = matchable(texts);
  for (const entry of entries) {
    const { tool, pattern: glob } = parseAutoApproveEntry(entry);
    if (tool !== request.name) continue;
    if (glob === undefined) bare = true;
    else if (!pattern && mayPattern && globMatch(glob, texts)) pattern = true;
  }
  if (bare) return { kind: "bare" };
  if (pattern) return { kind: "pattern", destructive: destructiveOf(request.name, request.input) };
  return { kind: "none" };
};
