/** Webhook routes: the registry, the `/hooks/:id` ingress and the test-fire. */
import { listWebhooks, removeWebhook } from "@spreissen/mind";
import { handleWebhookIngress, testWebhook } from "../webhooks.ts";
import type { RouteArgs } from "./types.ts";

export async function webhookRoutes(
  args: RouteArgs,
  segment: (after: string) => string,
): Promise<boolean> {
  const { req, mind, path, json } = args;
  const method = req.method ?? "GET";
  if (path === "/api/webhooks" && method === "GET") {
    json(200, await listWebhooks(mind.converse));
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
    try {
      const webhook = await mind.webhooks.create({
        sessionId: body.sessionId,
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
    json(200, { ok: await removeWebhook(mind.converse, segment("/api/webhooks/")) });
    return true;
  }
  // Test-fire: probe the schema without delivering — the debugger that key
  // invisibility makes mandatory.
  if (path.startsWith("/api/webhooks/") && path.endsWith("/test") && method === "POST") {
    const id = segment("/api/webhooks/").slice(0, -"/test".length);
    try {
      const body = await args.readJson<{ payload?: unknown }>(req);
      json(200, await testWebhook(mind, id, body.payload ?? {}));
    } catch (cause) {
      json(404, { error: String(cause).slice(0, 200) });
    }
    return true;
  }
  if (path.startsWith("/hooks/") && method === "POST") {
    const token = args.url.searchParams.get("token") ?? req.headers["x-ultiv-token"] ?? "";
    const body = (await args.readBody(req)).toString("utf8");
    const reply = await handleWebhookIngress(mind, segment("/hooks/"), String(token), body);
    json(reply.status, reply.json);
    return true;
  }
  return false;
}
