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
 * - `"bash@host:=<script>"` / `"bash@node:<nodeId>:=<script>"` — the EXACT
 *   entries, the only rules the `host` and `node` targets of the merged
 *   `bash` tool accept. They approve a call whose `script` is
 *   character-for-character the stored text and the target is the entry's
 *   own — no wildcards, no prefix match, no other field. "Always allow this
 *   exact command" on a host/node card saves one. Jev never decides a
 *   host/node call; this is the owner's own rule.
 *
 * TARGET-AWARE BARE/PATTERN RULE (the security design): bare `bash` grants
 * and `bash:glob` patterns cover ONLY the default `vm` target — by
 * definition, not by migration. A `host` or `node` call never matches a
 * bare or patterned entry, so merging the old `bash_host` tool into `bash`
 * widened nothing. Legacy `bash_host` entries are inert (the tool is gone;
 * boot migrates the exact ones to `bash@host:=`).
 *
 * Floors still outrank the list — the hook checks `isApprovalFloor` before
 * consulting this matcher, so no entry (bare or patterned) ever waves a
 * first-use credential/connector or `secret_request` call through.
 */
import { BASH_TOOL, bashNodeNameOf, bashTargetOf, type BashTarget } from "@spriessen/contracts";
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
 * Shell escape hatches, checked call-wide on every SHELL text:
 * - git's config-from-env flag (`--config-env=alias.p=EVIL` sets an alias
 *   whose value never appears in the text) and the sibling `-c`;
 * - a `git config …alias.*` write — the stored alias runs on a LATER plain
 *   call any `git *` pattern approves, a two-call escape single-call guards
 *   cannot see;
 * - git's exec/upload-pack hooks;
 * - interpreter eval flags (`node -e`, `perl -e`, `ruby -e`, …) keyed on the
 *   head word — a bare `-e` blocklist would refuse python's common
 *   `python3 -c 'print(1)'` (which stays refused anyway: `-c` is a git-style
 *   hatch position, and python is documented as not pattern-approvable);
 * - a `!` head at a position that starts a command (`!rm`, `-c x=!y` — after
 *   whitespace, start, `=`, `:` or a quote). Mid-word `!`
 *   (`git commit -m "fix typo!"`) is fine.
 */
const SHELL_ESCAPE = new RegExp(
  [
    /--config-env/,
    /(^|\s)-c(\s|$)/,
    /\bgit\s.*\bconfig\b.*\balias\./,
    /--exec-path/,
    /--upload-pack/,
    /(^|\s)(node|perl|ruby|php|deno|bun)\b[^\n]*\s(-e|--eval|-p)(\s|$)/,
    /(^|[\s=:'"])!/,
  ]
    .map((re) => re.source)
    .join("|"),
);

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

/** Compiled-glob memo: one RegExp per distinct glob, reused across gated calls. */
const GLOB_CACHE_LIMIT = 512;
const globCache = new Map<string, RegExp>();

/** Glob → RegExp: `*`/`?` stay inside one command's text, everything else literal; anchored hard (`$` must be the very end — no trailing-newline match). `\*`/`\?` are literals. */
export const globToRegExp = (glob: string): RegExp => {
  const cached = globCache.get(glob);
  if (cached !== undefined) return cached;
  const source: string[] = [];
  const literal = (ch: string): string => ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const chars = [...glob];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] ?? "";
    if (ch === "*") source.push(RUN_OF_CHARS);
    else if (ch === "?") source.push(ONE_CHAR);
    else if (ch === "\\" && i + 1 < chars.length) {
      i += 1;
      source.push(literal(chars[i] ?? ""));
    } else source.push(literal(ch));
  }
  // `(?![\s\S])` instead of `$`: `$` matches before a trailing newline, and
  // the matcher's newline refusal must not rest on the wildcard class alone.
  const re = new RegExp(`^${source.join("")}(?![\\s\\S])`);
  if (globCache.size >= GLOB_CACHE_LIMIT) globCache.clear();
  globCache.set(glob, re);
  return re;
};

/** Escape a literal action text into a glob that matches exactly it. */
export const globEscape = (text: string): string => text.replace(/[*?\\]/g, "\\$&");

/** Split an entry into its tool and optional pattern ("bash" → bash; "bash:git *" → bash + "git *"). */
export const parseAutoApproveEntry = (entry: string): { tool: string; pattern?: string } => {
  const i = entry.indexOf(":");
  return i === -1 ? { tool: entry } : { tool: entry.slice(0, i), pattern: entry.slice(i + 1) };
};

/**
 * Write-time shape check for an autoApprove entry: the tool half (before the
 * FIRST colon) must be non-empty and registry-safe (`[A-Za-z0-9_-]+`), and
 * the entry carries at most 4 wildcards — a long chain of `*a*a*a…` is a
 * catastrophic-backtracking input against the anchored glob (the hook runs
 * synchronously on every gated call), so the gate must not be able to stall
 * on a stored entry. A colon-named MCP tool cannot be expressed as a BARE
 * grant — `evil:x` reads as a pattern for tool `evil` — so colon-named tools
 * are only grantable by an explicit pattern (`evil:x:<pattern>`).
 */
const MAX_WILDCARDS = 4;

/**
 * The exact-entry shapes (target form and the pre-merge legacy form) are
 * compared as strings, never compiled — wildcards in them are literal.
 */
const EXACT_SHAPED = /^bash@(host|node:[A-Za-z0-9_-]+):=([\s\S]*)$|^[A-Za-z0-9_-]+:=([\s\S]*)$/;

export const validAutoApproveEntry = (entry: string): boolean =>
  EXACT_SHAPED.test(entry) ||
  (/^[A-Za-z0-9_-]+(:[\s\S]*)?$/.test(entry) &&
    (entry.match(/[*?]/g)?.length ?? 0) <= MAX_WILDCARDS);

/** The marker after `tool:` that makes an entry an exact match. */
const EXACT_MARK = "=";

/** An exact entry stores the whole script; longer than this isn't saved. */
export const MAX_EXACT_SCRIPT_CHARS = 2000;

/** The target an exact entry pins: host, or a node by its stored id. */
export type BashEntryTarget =
  | { readonly kind: "host" }
  | { readonly kind: "node"; readonly nodeId: string };

/**
 * The exact entry for one call's script: `bash@host:=<script>` or
 * `bash@node:<nodeId>:=<script>`. Plain-text storage, compared as a string —
 * wildcards in the script are literal there.
 */
export const targetExactEntry = (target: BashEntryTarget, script: string): string =>
  target.kind === "host"
    ? `bash@host:${EXACT_MARK}${script}`
    : `bash@node:${target.nodeId}:${EXACT_MARK}${script}`;

const TARGET_EXACT_RE = /^bash@host:=([\s\S]*)$/;
const TARGET_NODE_EXACT_RE = /^bash@node:([A-Za-z0-9_-]+):=([\s\S]*)$/;

/** Parse a target exact entry; undefined for every other string. */
export const parseTargetExactEntry = (
  entry: string,
): { readonly target: BashEntryTarget; readonly script: string } | undefined => {
  const host = TARGET_EXACT_RE.exec(entry);
  if (host !== null) return { target: { kind: "host" }, script: host[1] ?? "" };
  const node = TARGET_NODE_EXACT_RE.exec(entry);
  if (node !== null)
    return { target: { kind: "node", nodeId: node[1] ?? "" }, script: node[2] ?? "" };
  return undefined;
};

/** The legacy (pre-merge) host exact form, `bash_host:=<script>`; the boot migration rewrites it. */
export const legacyExactScriptOf = (entry: string): { readonly script: string } | undefined => {
  const { tool, pattern } = parseAutoApproveEntry(entry);
  return tool === "bash_host" && pattern?.startsWith(EXACT_MARK) === true
    ? { script: pattern.slice(EXACT_MARK.length) }
    : undefined;
};

/** The stored script of an exact entry in either stored form, or undefined. */
export const exactScriptOf = (
  entry: string,
): { readonly target: BashEntryTarget | "legacy"; readonly script: string } | undefined => {
  const targetForm = parseTargetExactEntry(entry);
  if (targetForm !== undefined) return targetForm;
  const legacy = legacyExactScriptOf(entry);
  return legacy === undefined ? undefined : { target: "legacy", ...legacy };
};

/**
 * The one script an exact entry can match: the input must be exactly
 * `{ script }` (a vm-target legacy call) or `{ script, target }` (and
 * optionally `node`, the paired node's name) — any other field or shape and
 * nothing matches.
 */
export const exactScriptInput = (
  input: unknown,
): { readonly script: string; readonly target: BashTarget } | undefined => {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const keys = Object.keys(input);
  if (keys.some((key) => key !== "script" && key !== "target" && key !== "node")) return undefined;
  const script = (input as Record<string, unknown>)["script"];
  if (typeof script !== "string") return undefined;
  const target = bashTargetOf(input);
  return target === "invalid" ? undefined : { script, target };
};

/** True when this call belongs to an exact-only surface: bash beyond the vm target. */
export const exactOnlyCall = (name: string, input: unknown): boolean =>
  name === BASH_TOOL && bashTargetOf(input) !== "vm";

/** How the list matches one call. */
export type AutoApproveMatch =
  | { readonly kind: "none" }
  /** An exact target entry (`bash@host:=` / `bash@node:<id>:=`) matched the whole script. */
  | { readonly kind: "exact" }
  /** A bare tool name matched — the owner's whole-tool grant, no sub-action checks. */
  | { readonly kind: "bare" }
  /**
   * A `tool:pattern` matched safely. `destructive` carries the Jev gate's
   * destructive read when the call also looks destructive — the hook
   * refuses these (fall through to Jev or the card); bare names ignore it.
   */
  | { readonly kind: "pattern"; readonly destructive: string | undefined };

/**
 * The sync node resolver the matcher MAY be given: the call's node name (or
 * null when the call names none — the single paired node) to its stored id.
 * The mind passes the registry-backed view so a saved exact node rule
 * matches the next identical call; without one, only a call that names the
 * node by its stored id can match.
 */
export type NodeIdOf = (name: string | null) => string | undefined;

/** The entry's target against the call's: host↔host, node↔node by resolved id. */
const targetMatches = (
  entry: BashEntryTarget,
  input: unknown,
  nodeIdOf: NodeIdOf | undefined,
): boolean => {
  if (entry.kind === "host") return bashTargetOf(input) === "host";
  if (bashTargetOf(input) !== "node") return false;
  const named = bashNodeNameOf(input);
  const resolved = nodeIdOf === undefined ? (named ?? undefined) : nodeIdOf(named);
  return resolved !== undefined && resolved === entry.nodeId;
};

/**
 * The one predicate for "would the autoApprove list approve this call" —
 * the broker hook answers gates with it, and rule saves (allowTool)
 * verify candidates with it, so a stored entry is exactly one the gate
 * would accept. Floors and yolo live above this in the hook. `nodeIdOf`
 * resolves a node call's paired node (see `NodeIdOf`); omit it when no
 * registry is wired.
 */
export const mayAutoApprove = (
  entries: readonly string[],
  request: ApprovalRequest,
  nodeIdOf?: NodeIdOf,
): boolean => {
  const match = matchAutoApprove(entries, request, nodeIdOf);
  return (
    match.kind === "bare" ||
    match.kind === "exact" ||
    (match.kind === "pattern" && match.destructive === undefined)
  );
};

/**
 * True when the whole call may be pattern-matched at all: NO candidate text
 * carries a chaining/substitution operator — a benign first field must not
 * approve a call whose second field chains a shell line — and no SHELL text
 * carries an escape hatch (also call-wide: the benign field must not vouch
 * for the one with the hatch).
 */
const matchable = (texts: readonly ActionText[]): boolean =>
  texts.every(({ text, shell }) => !UNSAFE_TEXT.test(text) && !(shell && SHELL_ESCAPE.test(text)));

/** True when EVERY candidate text matches the glob — one benign field must not vouch for the others. */
const globMatch = (glob: string, texts: readonly ActionText[]): boolean => {
  const re = globToRegExp(glob);
  return texts.length > 0 && texts.every(({ text }) => re.test(text));
};

/**
 * Match the list against one call. A bare name wins outright — for the
 * default `vm` target only; a `host`/`node` bash call matches ONLY a target
 * exact entry. A pattern must match the action text (any command field,
 * else top-level string values, else the serialised input) without crossing
 * a command boundary or carrying a shell escape hatch, and is reported with
 * the call's destructive read for the hook to refuse. Safe by default: an
 * empty pattern (`"tool:"`) matches only an empty action text, so it
 * approves nothing in practice.
 */
export const matchAutoApprove = (
  entries: readonly string[],
  request: ApprovalRequest,
  nodeIdOf?: NodeIdOf,
): AutoApproveMatch => {
  let bare = false;
  let exact = false;
  let pattern = false;
  // Beyond-VM reach (host/node): no bare grant, no pattern — an exact
  // target entry is the only rule form. An invalid target matches nothing.
  const restricted = exactOnlyCall(request.name, request.input);
  const script = request.name === BASH_TOOL ? exactScriptInput(request.input)?.script : undefined;
  const texts = actionTextsOf(request.input);
  const mayPattern = matchable(texts) && !restricted;
  for (const entry of entries) {
    const targetEntry = parseTargetExactEntry(entry);
    if (targetEntry !== undefined) {
      if (
        request.name === BASH_TOOL &&
        script !== undefined &&
        targetEntry.script === script &&
        targetMatches(targetEntry.target, request.input, nodeIdOf)
      )
        exact = true;
      continue;
    }
    const { tool, pattern: glob } = parseAutoApproveEntry(entry);
    if (tool !== request.name) continue;
    if (glob === undefined) {
      if (!restricted) bare = true;
    } else if (!pattern && mayPattern && globMatch(glob, texts)) pattern = true;
  }
  if (bare) return { kind: "bare" };
  if (exact) return { kind: "exact" };
  if (pattern) return { kind: "pattern", destructive: destructiveOf(request.name, request.input) };
  return { kind: "none" };
};
