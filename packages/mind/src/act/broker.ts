/**
 * The credential broker's mind wiring: `http_request` shows its cards through
 * the shared approval broker (so the 120s auto-deny, notes and the approval
 * inbox all apply) and records into the audit trail. The granted-credential
 * fallback resolves cross-home grants lazily — the converse service may not
 * exist yet when the broker is built.
 */
import { Effect } from "effect";
import {
  type BrowserFillDeps,
  brokerPlugin,
  createBrokerHooks,
  type BindingStore,
  type Plugin,
  type ScopeHolder,
  type VaultStore,
} from "@spriessen/ext";
import { Approvals } from "../approvals.ts";
import { Audit } from "../audit/audit.ts";
import type { ConverseService } from "../converse/converse.ts";
import { grantedCredential, type GrantedLookup } from "../org/reach.ts";

export const brokerFor = (
  vault: VaultStore | null,
  bindings: BindingStore | null,
  holder: ScopeHolder,
  /** Late-bound converse, for the org's cross-home grant lookups. */
  converseRef?: () => ConverseService | undefined,
  /** The bots' browsers, for `browser_login` (the broker's browser adapter). */
  browser?: BrowserFillDeps,
): Effect.Effect<Plugin, never, Approvals | Audit> =>
  Effect.gen(function* () {
    const approvals = yield* Approvals;
    const audit = yield* Audit;
    const hooks = createBrokerHooks();
    const grants: GrantedLookup | undefined =
      vault !== null && bindings !== null && converseRef !== undefined
        ? grantedCredential({ converse: converseRef, vault, bindings })
        : undefined;
    hooks.set({
      confirm: (conversationId, callId, request) =>
        Effect.runPromise(approvals.request(conversationId, callId, request)),
      noteFor: (conversationId, callId) => approvals.noteFor(conversationId, callId),
      audit: (event) => audit.record(event),
      ...(grants !== undefined ? { findGranted: grants } : {}),
    });
    return brokerPlugin({
      vault,
      bindings,
      holder,
      hooks,
      ...(browser !== undefined ? { browser } : {}),
    });
  });
