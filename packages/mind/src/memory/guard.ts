/**
 * The write guard: every memory write is stamped with its ORIGIN (the last
 * admitted input's bracket prefix), its TURN TAINT (untrusted-content tools
 * ran this turn), and ruled by both. Secrets never enter memory — a hit is
 * refused with advice to store a `vault:<item>` pointer instead.
 * Instruction-shaped text from non-owner origins is refused outright.
 */
import type { ConverseService } from "../converse/converse.ts";
import type { AuditService } from "../audit/audit.ts";
import type { FactTrust, FactKind } from "@spreissen/contracts";
import { Effect } from "effect";
import { normalize } from "./text.ts";

/** Where a write's content came from — read off the transcript, never trusted. */
export type Origin = "owner" | "cron" | "task" | "webhook" | "sensor" | "bot" | "unknown";

/** Tools whose results are outside content: hitting one taints the turn. */
export const BASE_UNTRUSTED_TOOLS: readonly string[] = [
  "web_fetch",
  "web_search",
  "http_request",
  "room",
  "mail_read",
  "mail_search",
  "calendar_list",
  "calendar_read",
];

export const originOfPrefix = (content: string): Origin => {
  const text = content.trimStart();
  if (text.startsWith("[cron ")) return "cron";
  if (text.startsWith("[task ") || text.startsWith("[from parent]")) return "task";
  if (text.startsWith("[webhook ")) return "webhook";
  if (text.startsWith("[sensor ")) return "sensor";
  if (text.startsWith("[message from ")) return "bot";
  if (text.startsWith("[owner]")) return "owner";
  // A plain admitted input is the owner speaking; any OTHER bracket prefix is
  // a shape the guard does not know — treat it as unknown, never owner.
  if (text.startsWith("[")) return "unknown";
  return "owner";
};

export interface WriteContext {
  readonly origin: Origin;
  readonly tainted: boolean;
  /** The last admitted owner input (for the tainted-instruction exception). */
  readonly ownerInput: string | null;
}

/**
 * The context of THIS turn: origin from the newest admitted user input,
 * taint from the audit trail (any untrusted-content tool since that input).
 */
export const contextOf = async (
  deps: {
    readonly converse: ConverseService;
    readonly audit?: AuditService;
    /** Names beyond the base set (e.g. installed MCP tools) that taint. */
    readonly untrustedTool?: (name: string) => boolean;
  },
  conversationId: string,
): Promise<WriteContext> => {
  const entries = await Effect.runPromise(deps.converse.entriesOf(conversationId, 40)).then(
    (records) => records,
    () => [],
  );
  let origin: Origin = "unknown";
  let ownerInput: string | null = null;
  let inputAt = 0;
  // entriesOf is NEWEST FIRST, so the first entry carrying a user message is
  // the newest admitted input — this turn's input. Its `timestamp` (unix ms)
  // anchors the taint window; entry ids are record ids, never timestamps.
  for (const entry of entries) {
    const user = entry.model?.find((message) => message.role === "user");
    if (user === undefined) continue;
    const content =
      typeof user.content === "string"
        ? user.content
        : user.content.map((block) => (block.type === "text" ? block.text : "")).join(" ");
    origin = originOfPrefix(content);
    if (origin === "owner" || content.trimStart().startsWith("[owner]")) ownerInput = content;
    inputAt = user.timestamp || 0;
    break;
  }
  const isUntrusted = (name: string): boolean =>
    BASE_UNTRUSTED_TOOLS.includes(name) || (deps.untrustedTool?.(name) ?? false);
  const tainted =
    deps.audit
      ?.tail(500)
      .some(
        (event) =>
          event.conversationId === conversationId &&
          typeof event.name === "string" &&
          isUntrusted(event.name) &&
          event.at >= inputAt,
      ) === true;
  return { origin, tainted, ownerInput };
};

export interface WritePolicy {
  readonly trust: FactTrust;
  /** Instruction facts are forbidden for this write. */
  readonly allowInstructions: boolean;
  /** Owner scope is forbidden for this write. */
  readonly allowOwnerScope: boolean;
  /** The trust ceiling a writer may claim. */
  readonly maxTrust: FactTrust;
}

const TRUST_ORDER: Record<FactTrust, number> = { owner: 3, self: 2, derived: 1, untrusted: 0 };

/** The rules by origin, unchanged authority on top. */
export const policyFor = (context: WriteContext): WritePolicy => {
  const { origin, tainted } = context;
  if (origin === "owner" && !tainted) {
    return { trust: "self", allowInstructions: true, allowOwnerScope: true, maxTrust: "owner" };
  }
  if (origin === "owner" && tainted) {
    // Copied from outside content: derived, not owner-voiced.
    return {
      trust: "derived",
      allowInstructions: false,
      allowOwnerScope: false,
      maxTrust: "derived",
    };
  }
  if (origin === "cron" || origin === "task") {
    return { trust: "self", allowInstructions: false, allowOwnerScope: false, maxTrust: "self" };
  }
  // webhook, sensor, bot, unknown: outside content entirely.
  return {
    trust: "untrusted",
    allowInstructions: false,
    allowOwnerScope: false,
    maxTrust: "untrusted",
  };
};

/** Resolve the trust a write may carry: min(requested, ceiling). */
export const trustFor = (requested: FactTrust, policy: WritePolicy): FactTrust =>
  TRUST_ORDER[requested] <= TRUST_ORDER[policy.maxTrust] ? requested : policy.maxTrust;

// --- content checks ---------------------------------------------------------

const SECRET_PATTERNS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  {
    label: "API key",
    pattern:
      /\b(sk-[A-Za-z0-9_-]{16,}|xox[abp]-[A-Za-z0-9-]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})\b/,
  },
  { label: "JWT", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  { label: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  {
    label: "bearer token",
    pattern: /\b(Bearer|token|password|passwd|pwd)\b[:= ]+[A-Za-z0-9/+_-]{16,}/i,
  },
];

/** Luhn check for 13–19 digit runs (cards). */
const luhn = (digits: string): boolean => {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let value = Number(digits[i] ?? 0);
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
};

const NIK = /\b\d{4}[.-]?\d{2}[.-]?\d{2}(?:[.-]\d{4})?[.-]?\d{4}\b/;

export interface ContentVerdict {
  readonly ok: boolean;
  readonly reason: string | null;
}

/** Refuse secrets, OTP-shaped codes and NIK numbers; advise a vault pointer. */
export const checkContent = (text: string): ContentVerdict => {
  for (const { label, pattern } of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      return {
        ok: false,
        reason:
          `refused: the text looks like a ${label}. Never store secrets in memory — ` +
          `save it in the vault and write a pointer like "credential for X is at vault:<item>".`,
      };
    }
  }
  const digitRuns = text.match(/\d{13,19}/g) ?? [];
  if (digitRuns.some((run) => luhn(run))) {
    return {
      ok: false,
      reason:
        "refused: the text contains a card-like number. Never store cards — " +
        'write a pointer like "payment card is at vault:<item>".',
    };
  }
  if (NIK.test(text)) {
    return {
      ok: false,
      reason:
        "refused: the text looks like a NIK (national ID). Never store IDs — " +
        'write a pointer like "NIK is at vault:<item>".',
    };
  }
  if (/\b(otp|verification code|kode verifikasi)\b[^0-9]{0,20}\d{4,8}\b/i.test(text)) {
    return {
      ok: false,
      reason: "refused: OTP/verification codes are single-use secrets — never store them.",
    };
  }
  return { ok: true, reason: null };
};

const INSTRUCTION_SHAPES: readonly RegExp[] = [
  /^(please\s+)?(always|never|remember to|make sure|ingat(lah)?\s|jangan\s|selalu\s|harus\s|pastikan\s|jangan lupa\s)/i,
  /\b(you must|from now on|mulai sekarang|dari sekarang)\b/i,
];

/** Instruction-shaped text from a non-owner origin is refused. */
export const looksLikeInstruction = (text: string): boolean =>
  INSTRUCTION_SHAPES.some((pattern) => pattern.test(text.trim()));

/**
 * The tainted-instruction exception: an owner-turn instruction survives
 * taint only when its text appears in the owner's own message.
 */
export const appearsInOwnerInput = (text: string, ownerInput: string | null): boolean => {
  if (ownerInput === null) return false;
  const needle = normalize(text).trim();
  return needle.length >= 8 && normalize(ownerInput).includes(needle);
};

/** The kinds a write may use, given the policy. */
export const kindsFor = (policy: WritePolicy): readonly FactKind[] =>
  policy.allowInstructions
    ? ["fact", "preference", "instruction", "event", "note"]
    : ["fact", "preference", "event", "note"];

/**
 * The core-line verdict: the always-on block renders in every prompt as the
 * owner's standing facts, so it is written ONLY from clean owner-voiced
 * turns — never webhook/sensor/cron/bot turns, never tainted turns, never
 * secret-bearing text. Same verdict shape as `checkContent`.
 */
export const coreVerdict = (context: WriteContext, text: string): ContentVerdict => {
  if (context.origin !== "owner") {
    return {
      ok: false,
      reason: `refused: core memory is written from the owner's own turns only (this turn: ${context.origin}).`,
    };
  }
  if (context.tainted) {
    return {
      ok: false,
      reason:
        "refused: this turn touched outside content; core memory is written on a clean owner turn.",
    };
  }
  return checkContent(text);
};
