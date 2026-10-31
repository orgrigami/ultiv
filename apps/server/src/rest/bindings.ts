/**
 * Credential-binding routes (owner-scoped like the vault's): where a secret
 * may be spent by `http_request` — hosts/URL prefixes, methods, auth
 * placement and which bots. Bindings never carry secret bytes.
 */
import { CredentialBindingInputSchema, type CredentialBindingInput } from "@spreissen/contracts";
import { Value } from "typebox/value";
import { errorOf, type RouteArgs } from "./types.ts";

const SPENDABLE = new Set(["key", "login", "note"]);

export async function bindingRoutes(
  args: RouteArgs,
  segment: (after: string) => string,
): Promise<boolean> {
  const { req, mind, path, json } = args;
  const method = req.method ?? "GET";
  if (path === "/api/vault/bindings" && method === "GET") {
    json(200, mind.bindings?.list(args.owner) ?? []);
    return true;
  }
  if (!path.startsWith("/api/vault/") || !path.endsWith("/binding")) return false;
  const id = segment("/api/vault/").slice(0, -"/binding".length);
  if (mind.vault === null || mind.bindings === null) {
    json(503, { error: "VAULT_KEY is not configured" });
    return true;
  }
  const item = mind.vault.get(args.owner, id);
  if (item === undefined) {
    json(404, { error: "unknown vault item" });
    return true;
  }
  if (method === "DELETE") {
    json(200, { ok: mind.bindings.remove(args.owner, id) });
    return true;
  }
  if (method !== "PUT") return false;
  if (item.access !== "secret" || !SPENDABLE.has(item.kind)) {
    json(400, { error: "only keys, logins and secret notes can be bound" });
    return true;
  }
  const body = await args.readJson<unknown>(req);
  if (!Value.Check(CredentialBindingInputSchema, body)) {
    json(400, { error: "invalid binding" });
    return true;
  }
  try {
    json(200, mind.bindings.put(args.owner, id, body as CredentialBindingInput));
  } catch (cause) {
    json(400, { error: errorOf(cause) });
  }
  return true;
}
