/** Webhook routes: the registry, the `/hooks/:id` ingress and the test-fire. */
import { listWebhooks, removeWebhook, rotateWebhookToken } from "@spreissen/mind";
import { handleWebhookIngress, testWebhook } from "../webhooks.ts";
import { findOwned, ownedRecords, ownedTarget } from "./owner-scope.ts";
import type { RouteArgs } from "./types.ts";

export async function webhookRoutes(
  args: RouteArgs,
  segment: (after: string) => string,
): Promise<boolean> {
  const { req, mind, path, json } = args;
  const method = req.method ?? "GET";
  if (path === "/api/webhooks" && method === "GET") {
    json(200, await ownedRecords(args, await listWebhooks(mind.converse)));
    return true;
  }
  if (path === "/api/webhooks" && method === "POST") {
    const body = await args.readJson<{
      sessionId?: string;
      name?: string;
      schema?: Record<string, unknown> | null;
    }>(req);
    if (body.sessionId === undefined || body.sessionId.trim() === "") {
      json(400, { error: "sessionId is required" });
      return true;
    }
    const target = await ownedTarget(args, body.sessionId);
    if (target === undefined) {
      json(404, { error: "unknown session" });
      return true;
    }
    try {
      const webhook = await mind.webhooks.create({
        sessionId: target,
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.schema !== undefined ? { schema: body.schema } : {}),
      });
      json(200, webhook);
    } catch (cause) {
      json(400, { error: String(cause).slice(0, 300) });
    }
    return true;
  }
  if (path.startsWith("/api/webhooks/") && method === "DELETE") {
    const id = segment("/api/webhooks/");
    const mine = await findOwned(args, await listWebhooks(mind.converse), id);
    json(200, { ok: mine !== undefined && (await removeWebhook(mind.converse, id)) });
    return true;
  }
  // New token: the old one stops working; the new one is in this response
  // only (just its hash is stored), like at creation.
  if (path.startsWith("/api/webhooks/") && path.endsWith("/token") && method === "POST") {
    const id = segment("/api/webhooks/").slice(0, -"/token".length);
    const mine = await findOwned(args, await listWebhooks(mind.converse), id);
    const rotated = mine !== undefined ? await rotateWebhookToken(mind.converse, id) : undefined;
    json(rotated !== undefined ? 200 : 404, rotated ?? { error: "unknown webhook" });
    return true;
  }
  // Test-fire: probe the schema without delivering — the debugger that key
  // invisibility makes mandatory.
  if (path.startsWith("/api/webhooks/") && path.endsWith("/test") && method === "POST") {
    const id = segment("/api/webhooks/").slice(0, -"/test".length);
    try {
      const body = await args.readJson<{ payload?: unknown }>(req);
      // Another owner's webhook gets the same 404 testWebhook gives a missing id.
      const mine = await findOwned(args, await listWebhooks(mind.converse), id);
      if (mine === undefined) throw new Error("unknown webhook");
      json(200, await testWebhook(mind, mine.id, body.payload ?? {}));
    } catch (cause) {
      json(404, { error: String(cause).slice(0, 200) });
    }
    return true;
  }
  if (path.startsWith("/hooks/") && method === "POST") {
    const token =
      args.url.searchParams.get("token") ??
      req.headers["x-spreissen-token"] ??
      req.headers["x-ultiv-token"] ??
      "";
    const body = (await args.readBody(req)).toString("utf8");
    const reply = await handleWebhookIngress(mind, segment("/hooks/"), String(token), body);
    json(reply.status, reply.json);
    return true;
  }
  return false;
}
