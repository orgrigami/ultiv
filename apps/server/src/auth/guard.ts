/**
 * The request gate: ONE decision for every HTTP surface (REST here, the
 * WebSocket upgrades in main.ts). Public routes pass; everything else needs a
 * valid session cookie, loopback included. Before a passcode exists the only
 * thing a loopback request can do is the one-time "set passcode" step, which
 * lives on a public route and re-checks loopback itself (auth/routes.ts); the
 * rest of the API and every socket stay closed until that step signs in.
 *
 * Cross-site defence stays layered: SameSite=Strict keeps the cookie off
 * cross-site requests, and every state-changing /api request must carry a
 * content type a page can only send after a CORS preflight (which the
 * wildcard CORS answer fails for credentialed requests), so a form or a
 * no-preflight fetch from another same-site origin (another localhost port)
 * cannot ride a session. CORS is unchanged by this file.
 */
import type { IncomingMessage } from "node:http";
import type { AuthStore } from "./store.ts";
import { sessionCookieOf } from "./http.ts";

export type Access =
  | { readonly kind: "public" }
  | { readonly kind: "session"; readonly sessionId: string }
  | { readonly kind: "refuse"; readonly status: number; readonly body: { error: string } };

/**
 * Routes that answer without a session: the health check, the webhook
 * ingress (its token IS the auth), and the sign-in routes themselves.
 * Everything else without a session gets the same refusal.
 */
export const isPublicRoute = (method: string, path: string): boolean => {
  if (path === "/api/health") return true;
  if (path.startsWith("/api/auth/")) return true;
  if (path.startsWith("/hooks/") && method === "POST") return true;
  return false;
};

/**
 * The content types (and the missing one) a page may send cross-origin
 * WITHOUT a preflight: a form post, or a fetch with a plain-text or typeless
 * body. Those are the only state-changing requests that reach the server
 * with the cookie and no CORS check, so a POST, PUT or PATCH under /api must
 * name something else: application/json for every route, and
 * application/octet-stream (or the file's own type) for raw-byte uploads.
 * DELETE and the other methods are always preflighted. SameSite=Strict is
 * the first fence; this is the second.
 */
const NO_PREFLIGHT_TYPES = new Set([
  "",
  "application/x-www-form-urlencoded",
  "multipart/form-data",
  "text/plain",
]);

export const contentTypeAllowed = (method: string, path: string, req: IncomingMessage): boolean => {
  if (method !== "POST" && method !== "PUT" && method !== "PATCH") return true;
  if (!path.startsWith("/api/")) return true;
  const type = (req.headers["content-type"] ?? "").toString().split(";")[0]?.trim().toLowerCase();
  return !NO_PREFLIGHT_TYPES.has(type ?? "");
};

/** The one access decision for a request. */
export const authorize = (req: IncomingMessage, store: AuthStore): Access => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = req.method ?? "GET";
  if (isPublicRoute(method, url.pathname)) return { kind: "public" };
  const cookie = sessionCookieOf(req);
  if (cookie !== undefined) {
    const row = store.session(cookie);
    if (row !== undefined) return { kind: "session", sessionId: cookie };
  }
  return refused();
};

const refused = (): {
  readonly kind: "refuse";
  readonly status: 401;
  readonly body: { error: string };
} => ({
  kind: "refuse",
  status: 401,
  // One shape for every refusal, so a probe learns nothing per-route.
  body: { error: "sign in required" },
});
