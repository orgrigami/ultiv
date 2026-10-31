/**
 * Who may call a connector, and when a call needs the owner's approval.
 * Default: every call waits for approval. The FIRST use of a server is
 * always asked under its own card name, which per-bot auto-approve lists
 * never cover. After that, read-only tools run unasked only where the owner
 * switched on "auto-allow read-only" for that server.
 */
import { Effect } from "effect";
import type { McpManager, McpServerView } from "@spreissen/ext";
import type { ApprovalsService } from "../approvals.ts";
import type { AuditService } from "../audit/audit.ts";
import type { ProfilesService } from "../profiles/profiles.ts";

export interface McpMindDeps {
  readonly manager: McpManager;
  readonly approvals: ApprovalsService;
  readonly audit: AuditService;
  readonly profiles: ProfilesService;
  readonly notes: UntrustedNotes;
  /** Per-call timeout for tool calls and resource reads. */
  readonly callTimeoutMs: number;
}

const FIRST_USE_PREFIX = "mcp (first use of ";

/** The approval card name of a server's first use. */
export const firstUseCardName = (slug: string): string => `${FIRST_USE_PREFIX}${slug})`;

/** True for first-use cards: auto-approve lists must never cover them. */
export const isMcpFirstUse = (name: string): boolean => name.startsWith(FIRST_USE_PREFIX);

export type Access =
  | { readonly ok: true; readonly view: McpServerView }
  | { readonly ok: false; readonly reason: string };

/** The servers a conversation's bot may use: same owner, enabled, assigned. */
export const visibleServers = (deps: McpMindDeps, conversationId: string): McpServerView[] => {
  const scope = deps.profiles.scopeOf(conversationId);
  if (scope === undefined) return [];
  return deps.manager
    .views()
    .filter(
      (view) =>
        view.record.owner === scope.owner &&
        (view.record.profiles === null || view.record.profiles.includes(scope.profileId)),
    );
};

export const accessOf = (
  deps: McpMindDeps,
  conversationId: string,
  owner: string,
  id: string,
): Access => {
  const scope = deps.profiles.scopeOf(conversationId);
  if (scope === undefined) return { ok: false, reason: "this conversation belongs to no bot" };
  if (scope.owner !== owner)
    return { ok: false, reason: "this connector belongs to another owner" };
  const view = deps.manager.view(owner, id);
  if (view === undefined) return { ok: false, reason: "this connector was removed" };
  if (!view.record.enabled) return { ok: false, reason: "this connector is switched off" };
  if (view.record.profiles !== null && !view.record.profiles.includes(scope.profileId)) {
    return { ok: false, reason: "this connector is not assigned to you" };
  }
  return { ok: true, view };
};

const DENIED =
  "not approved (the owner denied it, stopped the turn, or did not answer in time) — do not retry; tell the owner what was not done";

/** Null when the call may run; else the denial text for the model. */
export const approvalFor = async (
  deps: McpMindDeps,
  api: { readonly conversationId: unknown; readonly callId: string },
  view: McpServerView,
  call: { readonly name: string; readonly input: unknown; readonly readOnly: boolean },
): Promise<string | null> => {
  const conversationId = String(api.conversationId);
  const ask = async (name: string, input: unknown): Promise<string | null> => {
    const ok = await Effect.runPromise(
      deps.approvals.request(conversationId, api.callId, { callId: api.callId, name, input }),
    );
    return ok ? null : (deps.approvals.noteFor(conversationId, api.callId) ?? DENIED);
  };
  if (!view.record.firstUseApproved) {
    const denial = await ask(firstUseCardName(view.record.slug), {
      connector: view.record.name,
      tool: call.name,
      input: call.input,
    });
    if (denial === null) deps.manager.approveFirstUse(view.record.owner, view.record.id);
    return denial;
  }
  if (call.readOnly && view.record.autoAllowReadOnly) return null;
  return ask(call.name, call.input);
};

/** Conversations that saw connector output: their prompt carries the untrusted-data note. */
export interface UntrustedNotes {
  readonly mark: (conversationId: string) => void;
  readonly has: (conversationId: string) => boolean;
}

export const makeUntrustedNotes = (cap = 2_000): UntrustedNotes => {
  const seen = new Set<string>();
  return {
    mark: (conversationId) => {
      seen.delete(conversationId);
      seen.add(conversationId);
      if (seen.size > cap) seen.delete(seen.values().next().value as string);
    },
    has: (conversationId) => seen.has(conversationId),
  };
};
