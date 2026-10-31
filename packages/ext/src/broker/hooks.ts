/**
 * Late-bound mind services the broker needs: the approval broker (cards with
 * the 120s auto-deny) and the audit trail. The mind sets them once it is
 * built; until then every card is denied (fail closed).
 */
import type { AuditEvent } from "@spriessen/contracts";

export interface BrokerApprovalRequest {
  readonly callId: string;
  readonly name: string;
  readonly input: unknown;
}

export interface BrokerHooks {
  /** Show an approval card and wait for the owner (or the timeout's deny). */
  readonly confirm: (
    conversationId: string,
    callId: string,
    request: BrokerApprovalRequest,
  ) => Promise<boolean>;
  /** The owner's decision note for a call, if any. */
  readonly noteFor: (conversationId: string, callId: string) => string | undefined;
  readonly audit: (event: AuditEvent) => void;
  /**
   * The granted-credential fallback (the org's reach rules live in the
   * mind, not here): resolve a reference the bot's own vault scope does not
   * hold through an active cross-home grant. The returned binding still
   * governs the call; undefined keeps the ordinary refusal.
   */
  readonly findGranted?: (
    scope: { readonly owner: string; readonly profile: string },
    reference: string,
  ) => Promise<
    | {
        item: import("@spriessen/contracts").VaultItemInfo;
        binding: import("@spriessen/contracts").CredentialBinding;
      }
    | undefined
  >;
}

export interface BrokerHooksHolder {
  readonly get: () => BrokerHooks | undefined;
  readonly set: (hooks: BrokerHooks) => void;
}

export const createBrokerHooks = (): BrokerHooksHolder => {
  let current: BrokerHooks | undefined;
  return {
    get: () => current,
    set: (hooks) => {
      current = hooks;
    },
  };
};
