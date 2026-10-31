/**
 * Web Push REST, owner-scoped: the public VAPID key, subscribe/unsubscribe
 * for this owner's devices, tab presence (skip pushes while the app is
 * visible) and an owner-requested test push.
 */
import type { RouteArgs } from "./types.ts";

const TAB_PATTERN = /^[A-Za-z0-9_-]{6,64}$/;

export async function pushRoutes(args: RouteArgs): Promise<boolean> {
  const { req, path, json, push } = args;
  if (!path.startsWith("/api/push/")) return false;
  const method = req.method ?? "GET";
  if (push === undefined) {
    json(503, { error: "push is not available on this server" });
    return true;
  }
  if (path === "/api/push/config" && method === "GET") {
    json(200, {
      configured: push.config !== null,
      publicKey: push.config?.publicKey ?? null,
      devices: push.store.list(args.owner).length,
    });
    return true;
  }
  if (path === "/api/push/presence" && method === "POST") {
    const body = await args.readJson<{ tab?: unknown; visible?: unknown }>(req);
    if (typeof body.tab !== "string" || !TAB_PATTERN.test(body.tab)) {
      json(400, { error: "tab must be a short id" });
      return true;
    }
    push.presence.report(args.owner, body.tab, body.visible === true);
    json(200, { ok: true });
    return true;
  }
  if (push.config === null) {
    json(503, { error: "push is not configured: run vpr @spreissen/server#push:keys" });
    return true;
  }
  return subscriptionRoutes(args, method);
}

async function subscriptionRoutes(args: RouteArgs, method: string): Promise<boolean> {
  const { req, path, json } = args;
  const push = args.push;
  if (push === undefined) return false;
  if (path === "/api/push/subscribe" && method === "POST") {
    const body = await args.readJson<{ subscription?: unknown }>(req);
    const error = push.store.add(args.owner, body.subscription);
    json(error === null ? 200 : 400, error === null ? { ok: true } : { error });
    return true;
  }
  if (path === "/api/push/unsubscribe" && method === "POST") {
    const body = await args.readJson<{ endpoint?: unknown }>(req);
    const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
    json(200, { removed: push.store.remove(args.owner, endpoint) });
    return true;
  }
  if (path === "/api/push/test" && method === "POST") {
    const outcome = await push.notifier.notify(
      args.owner,
      { title: "Spreissen notifications are on", body: "This is a test.", url: "/", tag: "test" },
      { ignoreVisible: true },
    );
    json(200, { outcome });
    return true;
  }
  json(404, { error: `no route: ${method} ${path}` });
  return true;
}
