/**
 * Open reach: every bot reaches every department and the org. Reach covers
 * three surfaces — the shared folder, messaging any bot, and commands in
 * another home's VM (the run itself is Phase 4). There is no denial here;
 * the control is the audit row each CROSS-HOME use writes. Grants are the
 * other side: they unlock what reach does NOT cover, a NAMED vault item or
 * connector of another home.
 */
import { Effect } from "effect";
import type { AuditEvent, CredentialBinding, HomeRef, VaultItemInfo } from "@spriessen/contracts";
import type { BindingStore, VaultStore } from "@spriessen/ext";
import type { AuditService } from "../audit/audit.ts";
import type { ConverseService } from "../converse/converse.ts";
import type { MailboxService } from "../mailbox/mailbox.ts";
import { readProfiles } from "../profiles/docs.ts";
import { homeOf } from "./model.ts";
import { readOrgState } from "./service.ts";

const run = <A>(effect: Effect.Effect<A, unknown>): Promise<A> =>
  Effect.runPromise(effect) as Promise<A>;

export type ReachSurface = NonNullable<AuditEvent["reach"]>["surface"];

/** Two homes differ: the use is cross-home and audited. */
export const crossHome = (a: HomeRef, b: HomeRef): boolean => {
  if (a.kind !== b.kind) return true;
  return a.kind === "department" && b.kind === "department"
    ? a.departmentId !== b.departmentId
    : false;
};

/** One reach audit row: homes and surface only, never any content. */
export const auditReach = (
  audit: AuditService,
  event: {
    readonly profile: string | null;
    readonly conversationId: string;
    readonly from: HomeRef;
    readonly to: HomeRef;
    readonly surface: ReachSurface;
  },
): void => {
  audit.record({
    at: Date.now(),
    kind: "reach",
    conversationId: event.conversationId,
    profile: event.profile,
    callId: null,
    name: event.surface,
    durationMs: null,
    ok: true,
    error: null,
    reach: { from: event.from, to: event.to, surface: event.surface },
  });
};

/** Homes for the wrapper, resolved fresh per send (cheap doc reads). */
interface ReachDeps {
  readonly converse: ConverseService;
  readonly audit: AuditService;
}

/** The from/to homes of a mailbox send, or null when either bot is gone. */
const homesOfSend = async (
  converse: ConverseService,
  from: string,
  to: string,
): Promise<{ from: HomeRef; to: HomeRef } | null> => {
  const profiles = await run(readProfiles(converse));
  const sender = profiles.find((row) => row.id === from);
  const recipient = profiles.find((row) => row.id === to);
  if (sender === undefined || recipient === undefined) return null;
  return { from: homeOf(sender), to: homeOf(recipient) };
};

/**
 * Wrap the mailbox so a message BETWEEN HOMES writes its reach row. The
 * mailbox itself stays untouched (no department checks inside it); this is
 * the audit, not a gate — send behaves exactly as before.
 */
export const auditedMailbox = (mailbox: MailboxService, deps: ReachDeps): MailboxService => {
  const note = async (from: string, to: string): Promise<void> => {
    try {
      const homes = await homesOfSend(deps.converse, from, to);
      if (homes === null || !crossHome(homes.from, homes.to)) return;
      auditReach(deps.audit, {
        profile: from,
        conversationId: "mailbox",
        ...homes,
        surface: "message",
      });
    } catch {
      // Auditing observes; it must never break the send.
    }
  };
  return {
    ...mailbox,
    send: async (input) => {
      const entry = await mailbox.send(input);
      await note(input.from, input.to);
      return entry;
    },
  };
};

/**
 * The broker's granted-credential fallback: resolve a reference the bot's
 * own scope does NOT hold, through an active grant to the bot's home. The
 * item's binding still applies (hosts, methods, placement); the grant only
 * widens WHO may spend the item. Returns the resolution or undefined.
 */
export interface GrantedLookup {
  (
    scope: { readonly owner: string; readonly profile: string },
    reference: string,
  ): Promise<{ item: VaultItemInfo; binding: CredentialBinding } | undefined>;
}

export const grantedCredential = (deps: {
  /** Late-bound: the broker builds before converse exists. */
  readonly converse: () => ConverseService | undefined;
  readonly vault: VaultStore;
  readonly bindings: BindingStore;
}): GrantedLookup => {
  return async (scope, reference) => {
    const converse = deps.converse();
    if (converse === undefined) return undefined;
    const state = await readOrgState(converse);
    if (state.org === null) return undefined;
    const profiles = await run(readProfiles(converse));
    const me = profiles.find((row) => row.owner === scope.owner && row.id === scope.profile);
    if (me === undefined) return undefined;
    const home = homeOf(me);
    const wanted = reference.trim().toLowerCase();
    for (const grant of state.grants) {
      if (grant.revokedAt !== null) continue;
      if (grant.resource.kind !== "vault-item") continue;
      if (!sameHome(grant.grantee, home)) continue;
      const item = deps.vault.get(scope.owner, grant.resource.id);
      if (item === undefined) continue;
      const byId = item.id === reference.trim();
      const byName = item.name.toLowerCase() === wanted;
      if (!byId && !byName) continue;
      const binding = deps.bindings.get(scope.owner, item.id);
      if (binding === undefined) return undefined;
      return { item, binding };
    }
    return undefined;
  };
};

const sameHome = (a: HomeRef, b: HomeRef): boolean => !crossHome(a, b);
