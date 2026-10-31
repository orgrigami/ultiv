/**
 * The credential broker's mind wiring: `http_request` shows its cards through
 * the shared approval broker (so the 120s auto-deny, notes and the approval
 * inbox all apply) and records into the audit trail.
 */
import { Effect } from "effect";
import {
  brokerPlugin,
  createBrokerHooks,
  type BindingStore,
  type Plugin,
  type ScopeHolder,
  type VaultStore,
} from "@spreissen/ext";
import { Approvals } from "../approvals.ts";
import { Audit } from "../audit/audit.ts";

export const brokerFor = (
  vault: VaultStore | null,
  bindings: BindingStore | null,
  holder: ScopeHolder,
): Effect.Effect<Plugin, never, Approvals | Audit> =>
  Effect.gen(function* () {
    const approvals = yield* Approvals;
    const audit = yield* Audit;
    const hooks = createBrokerHooks();
    hooks.set({
      confirm: (conversationId, callId, request) =>
        Effect.runPromise(approvals.request(conversationId, callId, request)),
      noteFor: (conversationId, callId) => approvals.noteFor(conversationId, callId),
      audit: (event) => audit.record(event),
    });
    return brokerPlugin({
      vault,
      bindings,
      holder,
      hooks,
    });
  });
