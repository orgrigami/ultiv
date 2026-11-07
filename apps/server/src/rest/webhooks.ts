/** Webhook routes: the registry, the `/hooks/:id` ingress and the test-fire. */
import type { IncomingMessage } from "node:http";
import {
  listWebhooks,
  MAX_WEBHOOK_BODY_BYTES,
  removeWebhook,
  rotateWebhookToken,
  updateWebhook,
} from "@spriessen/mind";
import { handleWebhookIngress, testWebhook } from "../webhooks.ts";
import { findOwned, ownedRecords, ownedTarget } from "./owner-scope.ts";
import type { RouteArgs } from "./types.ts";

/**
 * Read a request body up to `limit` bytes. Past it the stream is paused and
 * left unread (`over`), so the answer goes out without buffering the rest.
 * Not `for await`: breaking out of it destroys the socket before the reply.
 */
export const readCapped = (
  req: IncomingMessage,
  limit: number,
): Promise<{ body: string; over: boolean }> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = (over: boolean): void => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", reject);
      if (over) req.pause();
      resolve({ body: Buffer.concat(chunks).subarray(0, limit).toString("utf8"), over });
    };
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
      size += chunk.length;
      if (size >= limit) finish(true);
    };
    const onEnd = (): void => finish(false);
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", reject);
  });

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
      threadKey?: string | null;
      threadTitle?: string | null;
      senders?: { path?: unknown; allow?: unknown } | null;
      trial?: boolean;
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
        ...(body.trial === true ? { trial: true } : {}),
        ...(typeof body.threadKey === "string" ? { threadKey: body.threadKey } : {}),
        ...(typeof body.threadTitle === "string" ? { threadTitle: body.threadTitle } : {}),
        ...(body.senders != null
          ? {
              senders: {
                path: typeof body.senders.path === "string" ? body.senders.path : "",
                allow: Array.isArray(body.senders.allow)
                  ? body.senders.allow.filter((name): name is string => typeof name === "string")
                  : [],
              },
            }
          : {}),
      });
      json(200, webhook);
    } catch (cause) {
      json(400, { error: String(cause).slice(0, 300) });
    }
    return true;
  }
  // Trial mode on or off ("Go live"); another owner's webhook is a 404.
  if (path.startsWith("/api/webhooks/") && method === "PATCH") {
    const id = segment("/api/webhooks/");
    const mine = await findOwned(args, await listWebhooks(mind.converse), id);
    const body = await args.readJson<{ trial?: unknown }>(req);
    if (mine === undefined) {
      json(404, { error: "unknown webhook" });
      return true;
    }
    if (typeof body.trial !== "boolean") {
      json(400, { error: "send trial as true or false" });
      return true;
    }
    const trial = body.trial;
    await updateWebhook(mind.converse, id, (row) => {
      const { trial: _was, ...rest } = row;
      return trial ? { ...rest, trial: true } : rest;
    });
    // Read it back: what updateWebhook returns was built inside the commit,
    // and draft values die with the transaction.
    json(200, (await findOwned(args, await listWebhooks(mind.converse), id)) ?? null);
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
      req.headers["x-spriessen-token"] ??
      req.headers["x-ultiv-token"] ??
      "";
    // Read at most one byte past the cap: this route needs no sign-in, so an
    // unbounded read would let anyone make the server buffer any size.
    const { body, over } = await readCapped(req, MAX_WEBHOOK_BODY_BYTES + 1);
    const reply = await handleWebhookIngress(mind, segment("/hooks/"), String(token), body);
    if (over) {
      // The rest of the upload is never read; close instead of draining it.
      args.res.setHeader("connection", "close");
      args.res.once("finish", () => req.destroy());
    }
    json(reply.status, reply.json);
    return true;
  }
  return false;
}
