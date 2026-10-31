/**
 * The request gate: ONE decision for every HTTP surface (REST here, the
 * WebSocket upgrades in main.ts). Public routes pass; everything else needs a
 * valid session cookie, loopback included. Before a passcode exists the only
 * thing a loopback request can do is the one-time "set passcode" step, which
 * lives on a public route and re-checks loopback itself (auth/routes.ts); the
 * rest of the API and every socket stay closed until that step signs in.
 *
 * Cross-site defence stays layered: SameSite=Strict keeps the cookie off
 * cross-site requests, and every state-changing /api route must speak JSON
 * (raw-byte uploads excepted), so a form or no-prefetch fetch cannot ride a
 * session even if same-site. CORS is unchanged by this file.
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
 * State-changing /api requests must not arrive as a cross-site form: the
 * form content types are what a top-level form (or a no-cors fetch) can
 * send, so they are refused outright; JSON and bodyless posts pass, and so
 * do raw-byte uploads (the composer and the smoke run post bytes with
 * whatever type the browser picks). SameSite=Strict is the first fence;
 * this is the second.
 */
const FORM_TYPES = new Set([
  "application/x-www-form-urlencoded",
  "multipart/form-data",
  "text/plain",
]);

export const contentTypeAllowed = (method: string, path: string, req: IncomingMessage): boolean => {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS" || method === "DELETE") {
    return true;
  }
  if (!path.startsWith("/api/")) return true;
  // Raw-byte uploads (and their metadata reads) are the exception.
  if (path === "/api/artifacts" || path.startsWith("/api/artifacts/")) return true;
  const type = (req.headers["content-type"] ?? "").toString().split(";")[0]?.trim().toLowerCase();
  return !(type !== undefined && type !== "" && FORM_TYPES.has(type));
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
