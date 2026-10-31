/**
 * Resolving a model's credential reference to a usable (item, binding,
 * secret material) triple — every policy check happens here, before any
 * secret is opened: visibility to the profile, secret class, binding
 * presence, adapter, and which bots may use it.
 */
import type { CredentialBinding, VaultItemInfo } from "@spreissen/contracts";
import type { VaultSecret, VaultStore } from "../vault.ts";
import type { BindingStore } from "./bindings.ts";
import type { SecretMaterial } from "./redact.ts";

/** Secrets this short would make redaction scrub ordinary text; refuse them. */
export const MIN_SECRET_LENGTH = 6;

export type Resolved =
  | { readonly ok: true; readonly item: VaultItemInfo; readonly binding: CredentialBinding }
  | { readonly ok: false; readonly reason: string };

/** Find the item by id or (unique, case-insensitive) name among the profile's visible items. */
export const findCredential = (
  vault: VaultStore,
  bindings: BindingStore,
  scope: { readonly owner: string; readonly profile: string },
  reference: string,
): Resolved => {
  const visible = vault
    .list(scope.owner, { profile: scope.profile })
    .filter((item) => item.access === "secret");
  const wanted = reference.trim().toLowerCase();
  const byId = visible.find((item) => item.id === reference.trim());
  const byName = visible.filter((item) => item.name.toLowerCase() === wanted);
  if (byId === undefined && byName.length > 1) {
    return { ok: false, reason: `several credentials are named "${reference}"; use its id` };
  }
  const item = byId ?? byName[0];
  if (item === undefined) {
    return { ok: false, reason: `no credential "${reference}" for this bot (see vault_list)` };
  }
  const binding = bindings.get(scope.owner, item.id);
  if (binding === undefined) {
    return {
      ok: false,
      reason: `"${item.name}" has no binding yet: ask your owner to set where it may be used in the app's Vault`,
    };
  }
  if (binding.adapter !== "http")
    return { ok: false, reason: `"${item.name}" is not an HTTP credential` };
  if (binding.profiles !== null && !binding.profiles.includes(scope.profile)) {
    return { ok: false, reason: `"${item.name}" is not allowed for this bot` };
  }
  return { ok: true, item, binding };
};

/** The secret material a vault item spends as (cards and contacts never). */
export const materialOf = (secret: VaultSecret | undefined): SecretMaterial | undefined => {
  if (secret === undefined) return undefined;
  switch (secret.kind) {
    case "key":
    case "note":
      return { secret: secret.secret, username: null };
    case "login":
      return { secret: secret.password, username: secret.username };
    default:
      return undefined;
  }
};
