/**
 * One readable sentence for the owner out of any error a turn can fail with
 * (the chat's error banner, `lastError`). Effect tagged errors carry an empty
 * `message`, so `String(error)` was just the tag ("spreissen/External"). This
 * reads the known fields (`reason`, `what`, `why`, `op`, an inner `cause`)
 * and the engine's unanswered reasons, never anything else of the error, and
 * scrubs secret-looking values. The full error still goes to the server log.
 */

const MAX_LENGTH = 300;
const FALLBACK = "Something went wrong";

/** Why the engine left a turn unanswered, in plain words. */
const UNANSWERED: Record<string, string> = {
  no_model: "No model is set for this chat. Pick one in the model menu and try again.",
  model_error: "The model returned an error",
  aborted: "The turn was stopped before it finished.",
  run_failed: "An earlier turn failed, so this message wasn't answered.",
  reset: "The chat was reset before this turn finished.",
};

/** What an `op` was doing, as the end of "… failed". */
const OP_LABEL: Record<string, string> = {
  "agent turn": "The reply",
  "agent wait": "Waiting for the reply",
  commit: "Saving the reply",
  submit: "Sending the message",
};

/** Values that look like credentials, replaced before anything is shown. */
const SECRETS: readonly [RegExp, string][] = [
  [
    /\b(token|access_token|api[_-]?key|key|secret|password|passwd|signature|sig|auth)=([^\s&"']+)/gi,
    "$1=•••",
  ],
  [/\b(authorization|cookie|set-cookie|x-api-key)\s*:\s*[^\n,;]+/gi, "$1: •••"],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer •••"],
  [/\b(sk|pk|rk|ghp|gho|ghs|xox[abprs])[-_][A-Za-z0-9_-]{8,}/g, "•••"],
  [/\b[A-Za-z0-9+/_-]{32,}={0,2}/g, "•••"],
];

export const scrubSecrets = (text: string): string =>
  SECRETS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);

const clean = (text: string): string => {
  const flat = scrubSecrets(text.replace(/\s+/g, " ").trim());
  return flat.length > MAX_LENGTH ? `${flat.slice(0, MAX_LENGTH - 1)}…` : flat;
};

const sentence = (text: string): string => (/[.!?…]$/.test(text) ? text : `${text}.`);

const field = (value: unknown, key: string): string | undefined => {
  const raw = (value as Record<string, unknown> | null | undefined)?.[key];
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : undefined;
};

/** The engine's "agent unanswered: {json}" cause (possibly cut short). */
const unansweredOf = (text: string): string | undefined => {
  if (!text.startsWith("agent unanswered")) return undefined;
  const reason = /"reason":"([a-z_]+)"/.exec(text)?.[1];
  if (reason === undefined) return "The turn ended without a reply.";
  const plain = UNANSWERED[reason] ?? "The turn ended without a reply.";
  const detail = /"detail":"((?:[^"\\]|\\.)*)/.exec(text)?.[1];
  return reason === "model_error" && detail !== undefined && detail !== ""
    ? `${plain}: ${detail.replace(/\\"/g, '"')}`
    : plain;
};

/** The innermost readable text of a cause, or undefined. */
const inner = (cause: unknown, depth: number): string | undefined => {
  if (depth > 3 || cause === undefined || cause === null) return undefined;
  if (typeof cause === "string") return cause.trim() === "" ? undefined : cause;
  if (typeof cause !== "object") return undefined;
  if (field(cause, "_tag") !== undefined) return describe(cause, depth + 1);
  return field(cause, "message") ?? inner((cause as { cause?: unknown }).cause, depth + 1);
};

const describe = (error: unknown, depth: number): string | undefined => {
  if (typeof error === "string") return unansweredOf(error) ?? (error.trim() || undefined);
  if (error === null || typeof error !== "object") return undefined;
  const tag = field(error, "_tag")?.replace(/^.*\//, "");
  switch (tag) {
    case "NotFound": {
      const what = field(error, "what");
      return what !== undefined ? `Couldn't find ${what}` : "Couldn't find what was asked for";
    }
    case "InvalidInput": {
      const reason = field(error, "reason");
      return reason !== undefined ? `Not accepted: ${reason}` : "That input wasn't accepted";
    }
    case "Unavailable": {
      const faculty = field(error, "faculty") ?? "That feature";
      const why = field(error, "why");
      return why !== undefined
        ? `${faculty} isn't available: ${why}`
        : `${faculty} isn't available`;
    }
    case "AuthMissing":
      return `${field(error, "connector") ?? "That connection"} isn't set up yet (its sign-in is missing)`;
    case "Duplicate":
      return `${field(error, "kind") ?? "That"} ${field(error, "id") ?? ""} already exists`.replace(
        /\s+/g,
        " ",
      );
    default:
      break;
  }
  const op = field(error, "op");
  const cause = (error as { cause?: unknown }).cause;
  const text =
    field(error, "reason") ??
    field(error, "what") ??
    field(error, "why") ??
    field(error, "message") ??
    inner(cause, depth);
  const unanswered = text !== undefined ? unansweredOf(text) : undefined;
  if (unanswered !== undefined) return unanswered;
  if (op === undefined) return text;
  const label = OP_LABEL[op] ?? `The step "${op}"`;
  return text !== undefined ? `${label} failed: ${text}` : `${FALLBACK} (${op})`;
};

export function ownerErrorText(error: unknown): string {
  const text = describe(error, 0);
  return sentence(clean(text ?? FALLBACK));
}
