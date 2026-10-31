/**
 * Secure input: a card in the chat with masked fields whose values go from
 * the browser straight to `submit` (a REST route), are sealed in the vault,
 * and never pass through the model, the transcript, the audit trail, logs or
 * notifications. The waiting tool parks on the approval broker (so the card
 * shows wherever approvals show) and learns only the stored item ids.
 */
import { Duration, Effect } from "effect";
import type { VaultStore } from "@spreissen/ext";
import type { ApprovalsService } from "../approvals.ts";

export const SECRET_REQUEST = "secret_request";

/** Shorter values would make output redaction scrub ordinary words. */
const MIN_CHARS = 6;
const MAX_CHARS = 10_000;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

export interface SecretField {
  /** Machine key, e.g. "api_key". */
  readonly key: string;
  /** What the owner sees, e.g. "API key". */
  readonly label: string;
}

/** What the card shows. Never holds a value. */
export interface SecretSpec {
  readonly label: string;
  readonly purpose: string;
  readonly fields: readonly SecretField[];
  /** Where the value will be sent, in plain words ("only to mcp.context7.com"). */
  readonly usedFor?: string | undefined;
}

export interface StoredSecret {
  readonly key: string;
  readonly itemId: string;
  readonly name: string;
}

export type SecretOutcome =
  | { readonly ok: true; readonly stored: readonly StoredSecret[] }
  | { readonly ok: false; readonly reason: string };

export type SubmitResult =
  | { readonly ok: true; readonly stored: readonly { key: string; name: string }[] }
  | { readonly ok: false; readonly status: number; readonly error: string };

export interface SecretRequestsService {
  /** Park until the owner submits or cancels (or the wait times out). */
  readonly ask: (
    conversationId: string,
    callId: string,
    spec: SecretSpec,
  ) => Promise<SecretOutcome>;
  /** The browser's values for one waiting request; owner-checked. */
  readonly submit: (owner: string, callId: string, values: Record<string, unknown>) => SubmitResult;
  readonly cancel: (owner: string, callId: string) => boolean;
}

interface Waiting {
  readonly conversationId: string;
  readonly owner: string;
  readonly spec: SecretSpec;
  result?: readonly StoredSecret[];
}

const CANCELLED =
  "the owner cancelled the secure input or did not answer in time; nothing was stored — do not ask again unless they want to";

const nameOf = (spec: SecretSpec, field: SecretField): string =>
  (spec.fields.length > 1 ? `${spec.label} · ${field.label}` : spec.label).slice(0, 120);

export const makeSecretRequests = (deps: {
  readonly approvals: ApprovalsService;
  readonly vault: VaultStore | null;
  readonly ownerOf: (conversationId: string) => string | undefined;
  readonly timeoutMs?: number;
}): SecretRequestsService => {
  const waiting = new Map<string, Waiting>();
  const isWaiting = (entry: Waiting, callId: string): boolean =>
    deps.approvals.pendingFor(entry.conversationId).some((request) => request.callId === callId);

  const store = (owner: string, entry: Waiting, values: Record<string, unknown>): SubmitResult => {
    const vault = deps.vault;
    if (vault === null) return { ok: false, status: 503, error: "the vault is not set up" };
    for (const field of entry.spec.fields) {
      const value = values[field.key];
      if (typeof value !== "string" || value.trim().length < MIN_CHARS)
        return { ok: false, status: 400, error: `${field.label} looks too short` };
      if (value.length > MAX_CHARS)
        return { ok: false, status: 400, error: `${field.label} is too long` };
    }
    const stored = entry.spec.fields.map((field) => {
      const item = vault.create(owner, {
        kind: "key",
        name: nameOf(entry.spec, field),
        key: { service: entry.spec.label.slice(0, 120), secret: String(values[field.key]).trim() },
      });
      return { key: field.key, itemId: item.id, name: item.name };
    });
    entry.result = stored;
    return { ok: true, stored: stored.map(({ key, name }) => ({ key, name })) };
  };

  return {
    ask: async (conversationId, callId, spec) => {
      if (deps.vault === null) return { ok: false, reason: "the vault is not set up (VAULT_KEY)" };
      const owner = deps.ownerOf(conversationId);
      if (owner === undefined) return { ok: false, reason: "this conversation belongs to no bot" };
      const entry: Waiting = { conversationId, owner, spec };
      waiting.set(callId, entry);
      try {
        const input = {
          label: spec.label,
          purpose: spec.purpose,
          ...(spec.usedFor !== undefined ? { usedFor: spec.usedFor } : {}),
          fields: spec.fields.map(({ key, label }) => ({ key, label })),
        };
        const approved = await Effect.runPromise(
          deps.approvals.request(
            conversationId,
            callId,
            { callId, name: SECRET_REQUEST, input },
            { timeout: Duration.millis(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS) },
          ),
        );
        if (approved && entry.result !== undefined) return { ok: true, stored: entry.result };
        const note = deps.approvals.noteFor(conversationId, callId);
        return {
          ok: false,
          reason: approved ? "nothing was entered, so nothing was stored" : (note ?? CANCELLED),
        };
      } finally {
        waiting.delete(callId);
      }
    },
    submit: (owner, callId, values) => {
      const entry = waiting.get(callId);
      if (entry === undefined || entry.owner !== owner || !isWaiting(entry, callId))
        return { ok: false, status: 404, error: "this request is no longer waiting" };
      let result: SubmitResult;
      try {
        result = store(owner, entry, values);
      } catch {
        // The vault's own error could quote input; say it plainly instead.
        return { ok: false, status: 500, error: "couldn't store it in the vault" };
      }
      if (result.ok) deps.approvals.decide(entry.conversationId, callId, true);
      return result;
    },
    cancel: (owner, callId) => {
      const entry = waiting.get(callId);
      if (entry === undefined || entry.owner !== owner) return false;
      deps.approvals.decide(entry.conversationId, callId, false, CANCELLED);
      return true;
    },
  };
};
