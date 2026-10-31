/**
 * The credential broker's adapter seam. A sealed vault secret is spent only
 * through an adapter: it checks the request against the item's binding BEFORE
 * the secret is opened, performs the call with the secret placed by policy,
 * and returns a result the broker scrubs before anything model-facing sees
 * it. HTTP is the first adapter; ssh/git/SMTP/IMAP/DB/env adapters implement
 * the same shape later (their bindings add adapter-specific fields).
 */
import type { CredentialAdapter, CredentialBinding } from "@spreissen/contracts";
import type { SecretMaterial } from "./redact.ts";

/** Why a binding refuses a request (model-facing; never mentions the secret). */
export type BindingCheck =
  | { readonly ok: true; readonly host: string }
  | { readonly ok: false; readonly reason: string };

export interface CredentialAdapterImpl<Request, Result> {
  readonly kind: CredentialAdapter;
  /** Policy only: may this binding be used for this request, and on which host? */
  readonly check: (binding: CredentialBinding, request: Request) => BindingCheck;
  /** Run the request; `secret` is null for credential-less calls. */
  readonly perform: (
    request: Request,
    secret: { readonly material: SecretMaterial; readonly binding: CredentialBinding } | null,
  ) => Promise<Result>;
}
