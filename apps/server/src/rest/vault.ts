/**
 * Vault routes: human-only entry for secrets (the model never carries the
 * bytes — anything it touches lands in a durable transcript). Responses are
 * metadata + masks only.
 */
import type { VaultItemCreate } from "@spreissen/contracts";
import { errorOf, queryOr, type RouteArgs } from "./types.ts";

export async function vaultRoutes(
  args: RouteArgs,
  segment: (after: string) => string,
): Promise<boolean> {
  const { req, mind, path, json } = args;
  const method = req.method ?? "GET";
  if (path === "/api/vault" && method === "GET") {
    if (mind.vault === null) {
      json(200, { items: [], configured: false });
      return true;
    }
    const profile = queryOr(args, "profile");
    const items = mind.vault.list(args.owner, profile !== undefined ? { profile } : {});
    // Strip the REST response down to metadata (the store never returns secrets).
    json(
      200,
      items.map(({ id, name, kind, access, masked, profile, createdAt, lastUsedAt }) => ({
        id,
        name,
        kind,
        access,
        masked,
        profile,
        createdAt,
        lastUsedAt,
      })),
    );
    return true;
  }
  if (path === "/api/vault" && method === "POST") {
    if (mind.vault === null) {
      json(503, { error: "VAULT_KEY is not configured" });
      return true;
    }
    try {
      const item = await mind.vault.create(args.owner, await args.readJson<VaultItemCreate>(req));
      json(200, item);
    } catch (cause) {
      json(400, { error: errorOf(cause) });
    }
    return true;
  }
  if (path.startsWith("/api/vault/") && method === "GET") {
    const item = mind.vault?.get(args.owner, segment("/api/vault/"));
    if (item === undefined) json(404, { error: "unknown vault item" });
    else json(200, item);
    return true;
  }
  if (path.startsWith("/api/vault/") && method === "DELETE") {
    const id = segment("/api/vault/");
    const deleted = mind.vault?.remove(args.owner, id) ?? false;
    // A deleted secret's binding goes with it (a new item never inherits it).
    if (deleted) mind.bindings?.remove(args.owner, id);
    if (deleted) json(200, { ok: true });
    else json(404, { error: "unknown vault item" });
    return true;
  }
  return false;
}
