/**
 * The sign-in routes: status, first-time passcode setup (loopback only),
 * sign-in, sign-out and passcode change. Mounted inside the gate, so a
 * request here already passed the public-route or session check; these
 * handlers re-check what the gate cannot know (setup needs NO passcode yet
 * and a direct loopback peer; change needs the current passcode).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuditEvent } from "@spriessen/contracts";
import type { AuditService } from "@spriessen/mind";
import { SESSION_COOKIE, SESSION_TTL_MS } from "./config.ts";
import { isHttps, isLoopback, readJsonBody, serializeCookie, sessionCookieOf } from "./http.ts";
import type { AuthStore } from "./store.ts";

/** One owner-level auth event; never carries the attempted passcode. */
export const authEvent = (at: number, name: string, ok: boolean, error?: string): AuditEvent => ({
  at,
  kind: "auth",
  conversationId: "",
  profile: null,
  callId: null,
  name,
  durationMs: null,
  ok,
  error: error ?? null,
});

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, x-spriessen-user, x-ultiv-user",
};

const sendJson = (res: ServerResponse, status: number, body: unknown, cookie?: string): void => {
  res.writeHead(status, {
    "content-type": "application/json",
    ...CORS_HEADERS,
    ...(cookie !== undefined ? { "set-cookie": cookie } : {}),
  });
  res.end(JSON.stringify(body));
};

const issueCookie = (req: IncomingMessage, sessionId: string): string =>
  serializeCookie(SESSION_COOKIE, sessionId, { maxAge: SESSION_TTL_MS, secure: isHttps(req) });

/** Handles /api/auth/*; false when the path is not one of these routes. */
export const handleAuthRoutes = async (
  req: IncomingMessage,
  res: ServerResponse,
  store: AuthStore,
  audit?: AuditService,
): Promise<boolean> => {
  const record = (name: string, ok: boolean, error?: string): void =>
    audit?.record(authEvent(Date.now(), name, ok, error));
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith("/api/auth/")) return false;
  const method = req.method ?? "GET";
  if (url.pathname === "/api/auth/status" && method === "GET") {
    status(req, res, store);
    return true;
  }
  if (url.pathname === "/api/auth/passcode" && method === "POST") {
    return setPasscode(req, res, store, record);
  }
  if (url.pathname === "/api/auth/sign-in" && method === "POST") {
    return signIn(req, res, store, record);
  }
  if (url.pathname === "/api/auth/sign-out" && method === "POST") {
    signOut(req, res, store, record);
    return true;
  }
  if (url.pathname === "/api/auth/passcode/change" && method === "POST") {
    return changePasscode(req, res, store, record);
  }
  sendJson(res, 404, { error: `no auth route: ${method} ${url.pathname}` });
  return true;
};

const status = (req: IncomingMessage, res: ServerResponse, store: AuthStore): void => {
  const cookie = sessionCookieOf(req);
  sendJson(res, 200, {
    passcodeSet: store.passcodeSet,
    // Bootstrap means THIS request may set the first passcode.
    bootstrap: !store.passcodeSet && isLoopback(req),
    session: cookie !== undefined && store.session(cookie) !== undefined,
  });
};

const setPasscode = async (
  req: IncomingMessage,
  res: ServerResponse,
  store: AuthStore,
  record: (name: string, ok: boolean, error?: string) => void,
): Promise<boolean> => {
  if (store.passcodeSet) {
    sendJson(res, 409, { error: "a passcode is already set; sign in instead" });
    return true;
  }
  if (!isLoopback(req)) {
    // The one-time setup happens at the machine, never over the LAN.
    record("passcode-set", false, "refused: not the host");
    sendJson(res, 403, { error: "set the first passcode on the host itself" });
    return true;
  }
  const body = await readJsonBody<{ passcode?: string }>(req);
  if ((body.passcode ?? "").length < 8) {
    sendJson(res, 400, { error: "use at least 8 characters for the passcode" });
    return true;
  }
  store.setPasscode(body.passcode ?? "");
  record("passcode-set", true);
  sendJson(res, 200, { ok: true }, issueCookie(req, store.createSession()));
  return true;
};

const signIn = async (
  req: IncomingMessage,
  res: ServerResponse,
  store: AuthStore,
  record: (name: string, ok: boolean, error?: string) => void,
): Promise<boolean> => {
  const body = await readJsonBody<{ passcode?: string }>(req);
  const outcome = store.attempt(body.passcode ?? "");
  if (outcome === "locked") {
    record("sign-in", false, "refused: throttled");
    const wait = store.lockedFor();
    res.writeHead(429, {
      "content-type": "application/json",
      "retry-after": String(wait),
      ...CORS_HEADERS,
    });
    res.end(JSON.stringify({ error: `too many attempts; wait ${wait}s` }));
    return true;
  }
  if (outcome !== "ok") {
    // The answer never says which part was wrong; the attempt is throttled.
    record("sign-in", false, "wrong passcode");
    sendJson(res, 401, { error: "wrong passcode" });
    return true;
  }
  record("sign-in", true);
  sendJson(res, 200, { ok: true }, issueCookie(req, store.createSession()));
  return true;
};

const signOut = (
  req: IncomingMessage,
  res: ServerResponse,
  store: AuthStore,
  record: (name: string, ok: boolean, error?: string) => void,
): void => {
  const sessionId = sessionCookieOf(req);
  if (sessionId !== undefined) store.deleteSession(sessionId);
  record("sign-out", true);
  sendJson(
    res,
    200,
    { ok: true },
    serializeCookie(SESSION_COOKIE, "", { clear: true, secure: isHttps(req) }),
  );
};

const changePasscode = async (
  req: IncomingMessage,
  res: ServerResponse,
  store: AuthStore,
  record: (name: string, ok: boolean, error?: string) => void,
): Promise<boolean> => {
  if (!store.passcodeSet) {
    sendJson(res, 409, { error: "no passcode is set yet" });
    return true;
  }
  const body = await readJsonBody<{ current?: string; next?: string }>(req);
  if ((body.next ?? "").length < 8) {
    sendJson(res, 400, { error: "use at least 8 characters for the new passcode" });
    return true;
  }
  if (!store.changePasscode(body.current ?? "", body.next ?? "")) {
    record("passcode-change", false, "wrong passcode");
    sendJson(res, 401, { error: "wrong passcode" });
    return true;
  }
  record("passcode-change", true);
  sendJson(res, 200, { ok: true });
  return true;
};
