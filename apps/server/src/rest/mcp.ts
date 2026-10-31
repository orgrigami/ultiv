/**
 * Connector (MCP server) routes, all owner-scoped: list, add, edit, remove,
 * reconnect, and the OAuth "Connect" pair. The callback carries no owner
 * header — the single-use `state` minted at Connect binds owner and server.
 * Responses never carry secrets (configs reference vault items by id).
 */
import type { IncomingMessage } from "node:http";
import { Value } from "typebox/value";
import { McpServerInputSchema, type McpServerInput } from "@spreissen/contracts";
import { defaultRedirectUrl } from "@spreissen/ext";
import { errorOf, type RouteArgs } from "./types.ts";

export const CALLBACK_PATH = "/api/mcp/oauth/callback";

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/** The callback URL: MCP_OAUTH_CALLBACK_URL, else the browser's own origin. */
export const callbackUrlFor = (req: IncomingMessage): string => {
  if (process.env.MCP_OAUTH_CALLBACK_URL?.trim()) return defaultRedirectUrl();
  const origin = first(req.headers.origin);
  if (origin !== undefined && /^https?:\/\/[^/\s]+$/i.test(origin))
    return `${origin}${CALLBACK_PATH}`;
  const host = first(req.headers["x-forwarded-host"]) ?? first(req.headers.host);
  const proto = first(req.headers["x-forwarded-proto"]) ?? "http";
  return host !== undefined && /^[\w.:[\]-]+$/.test(host)
    ? `${proto === "https" ? "https" : "http"}://${host}${CALLBACK_PATH}`
    : defaultRedirectUrl();
};

const readInput = async (args: RouteArgs): Promise<McpServerInput> => {
  const body = await args.readJson<unknown>(args.req);
  if (!Value.Check(McpServerInputSchema, body)) {
    const first = [...Value.Errors(McpServerInputSchema, body)][0];
    throw new Error(
      first === undefined
        ? "invalid connector"
        : `invalid connector: ${first.instancePath || "body"} ${first.message}`,
    );
  }
  return body;
};

const page = (title: string, text: string): string =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<meta name="color-scheme" content="light dark"><title>${title}</title>` +
  `<body style="font:16px system-ui;padding:32px;max-width:28rem;margin:auto">` +
  `<h1 style="font-size:20px">${title}</h1><p>${text}</p>` +
  `<p><a href="/connectors" style="display:inline-block;padding:12px 0">Back to Connectors</a></p>` +
  `<script>setTimeout(()=>{try{window.close()}catch{}},1500)</script></body>`;

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const oauthCallback = async (args: RouteArgs): Promise<void> => {
  const { url, res, mind } = args;
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  const iss = url.searchParams.get("iss") ?? undefined;
  let html: string;
  try {
    if (error !== null || code === null) {
      throw new Error(
        error === null ? "no authorization code came back" : `the server said: ${error}`,
      );
    }
    const info = await mind.mcp.finishSignIn(state, code, iss);
    html = page("Signed in", `${escapeHtml(info.name)} is connected. You can close this tab.`);
  } catch (cause) {
    html = page("Sign-in failed", `${escapeHtml(errorOf(cause).slice(0, 300))} Try Connect again.`);
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(html);
};

/** One server route by id: PATCH, DELETE, reconnect, connect, sign-out. */
const serverRoute = async (args: RouteArgs, rest: string): Promise<boolean> => {
  const { req, mind, json, owner } = args;
  const method = req.method ?? "GET";
  const [id = "", action] = rest.split("/");
  if (action === undefined && method === "PATCH") {
    json(200, await mind.mcp.update(owner, id, await readInput(args)));
  } else if (action === undefined && method === "DELETE") {
    const ok = await mind.mcp.remove(owner, id);
    if (ok) json(200, { ok });
    else json(404, { error: "no such connector" });
  } else if (action === "reconnect" && method === "POST") {
    json(200, await mind.mcp.reconnect(owner, id));
  } else if (action === "connect" && method === "POST") {
    const url = await mind.mcp.signIn(owner, id, callbackUrlFor(req));
    json(200, { url, state: mind.mcp.info(owner, id)?.state ?? "failed" });
  } else if (action === "signout" && method === "POST") {
    json(200, await mind.mcp.signOut(owner, id));
  } else {
    return false;
  }
  return true;
};

export async function mcpRoutes(args: RouteArgs): Promise<boolean> {
  const { req, path, mind, json, owner } = args;
  const method = req.method ?? "GET";
  if (path === CALLBACK_PATH && method === "GET") {
    await oauthCallback(args);
    return true;
  }
  if (!path.startsWith("/api/mcp/servers")) return false;
  try {
    if (path === "/api/mcp/servers" && method === "GET") {
      json(200, { servers: mind.mcp.list(owner), callbackUrl: callbackUrlFor(req) });
      return true;
    }
    if (path === "/api/mcp/servers" && method === "POST") {
      json(200, mind.mcp.add(owner, await readInput(args)));
      return true;
    }
    if (path.startsWith("/api/mcp/servers/")) {
      return await serverRoute(args, decodeURIComponent(path.slice("/api/mcp/servers/".length)));
    }
  } catch (cause) {
    const status = (cause as { _tag?: string })._tag === "spreissen/NotFound" ? 404 : 400;
    json(status, { error: errorOf(cause).slice(0, 300) });
    return true;
  }
  return false;
}
