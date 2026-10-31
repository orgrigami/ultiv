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
import {
  authenticationOptionsFor,
  registerPasskey,
  registrationOptionsFor,
  verifyPasskeySignIn,
} from "./passkeys.ts";
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
  if (url.pathname === "/api/auth/passkey/register-options" && method === "POST") {
    return passkeyRegisterOptions(req, res, store);
  }
  if (url.pathname === "/api/auth/passkey/register" && method === "POST") {
    return passkeyRegister(req, res, store, record);
  }
  if (url.pathname === "/api/auth/passkey/auth-options" && method === "POST") {
    return passkeyAuthOptions(req, res, store);
  }
  if (url.pathname === "/api/auth/passkey/auth" && method === "POST") {
    return passkeyAuth(req, res, store, record);
  }
  if (url.pathname === "/api/auth/passkeys" && method === "GET") {
    return passkeyList(req, res, store);
  }
  const passkeyRemove = url.pathname.match(/^\/api\/auth\/passkeys\/([^/]+)$/);
  if (passkeyRemove !== null && method === "DELETE") {
    return passkeyDelete(req, res, store, decodeURIComponent(passkeyRemove[1] ?? ""));
  }
  sendJson(res, 404, { error: `no auth route: ${method} ${url.pathname}` });
  return true;
};

/** A real session (not just the bootstrap) — passkey management needs it. */
const signedIn = (req: IncomingMessage, store: AuthStore): boolean => {
  const sessionId = sessionCookieOf(req);
  return sessionId !== undefined && store.session(sessionId) !== undefined;
};

const passkeyRegisterOptions = async (
  req: IncomingMessage,
  res: ServerResponse,
  store: AuthStore,
): Promise<boolean> => {
  if (!signedIn(req, store)) {
    sendJson(res, 401, { error: "sign in first" });
    return true;
  }
  const { options, token } = await registrationOptionsFor(req, store);
  sendJson(res, 200, { options, token });
  return true;
};

const passkeyRegister = async (
  req: IncomingMessage,
  res: ServerResponse,
  store: AuthStore,
  record: (name: string, ok: boolean, error?: string) => void,
): Promise<boolean> => {
  if (!signedIn(req, store)) {
    sendJson(res, 401, { error: "sign in first" });
    return true;
  }
  const body = await readJsonBody<{ token?: string; response?: object }>(req);
  if (body.response === undefined) {
    sendJson(res, 400, { error: "the authenticator's answer is missing" });
    return true;
  }
  const result = await registerPasskey(req, store, body.token ?? "", body.response as never);
  if (!result.ok) {
    sendJson(res, 400, { error: result.error ?? "could not add the passkey" });
    return true;
  }
  record("passkey-added", true);
  sendJson(res, 200, { ok: true });
  return true;
};

const passkeyAuthOptions = async (
  req: IncomingMessage,
  res: ServerResponse,
  store: AuthStore,
): Promise<boolean> => {
  if (store.passkeys().length === 0) {
    sendJson(res, 404, { error: "no passkey is set up on this server" });
    return true;
  }
  const { options, token } = await authenticationOptionsFor(req, store);
  sendJson(res, 200, { options, token });
  return true;
};

const passkeyAuth = async (
  req: IncomingMessage,
  res: ServerResponse,
  store: AuthStore,
  record: (name: string, ok: boolean, error?: string) => void,
): Promise<boolean> => {
  const body = await readJsonBody<{ token?: string; response?: object }>(req);
  if (body.response === undefined) {
    sendJson(res, 400, { error: "the authenticator's answer is missing" });
    return true;
  }
  const ok = await verifyPasskeySignIn(req, store, body.token ?? "", body.response as never);
  if (!ok) {
    record("sign-in", false, "passkey not verified");
    sendJson(res, 401, { error: "the passkey could not be verified" });
    return true;
  }
  record("sign-in", true);
  sendJson(res, 200, { ok: true }, issueCookie(req, store.createSession()));
  return true;
};

const passkeyList = async (
  req: IncomingMessage,
  res: ServerResponse,
  store: AuthStore,
): Promise<boolean> => {
  if (!signedIn(req, store)) {
    sendJson(res, 401, { error: "sign in first" });
    return true;
  }
  sendJson(
    res,
    200,
    store.passkeys().map((key) => ({ id: key.id, createdAt: key.createdAt })),
  );
  return true;
};

const passkeyDelete = async (
  req: IncomingMessage,
  res: ServerResponse,
  store: AuthStore,
  id: string,
): Promise<boolean> => {
  if (!signedIn(req, store)) {
    sendJson(res, 401, { error: "sign in first" });
    return true;
  }
  sendJson(res, 200, { ok: store.removePasskey(id) });
  return true;
};

const status = (req: IncomingMessage, res: ServerResponse, store: AuthStore): void => {
  const cookie = sessionCookieOf(req);
  sendJson(res, 200, {
    passcodeSet: store.passcodeSet,
    // Bootstrap means THIS request may set the first passcode.
    bootstrap: !store.passcodeSet && isLoopback(req),
    session: cookie !== undefined && store.session(cookie) !== undefined,
    passkeys: store.passkeys().length > 0,
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
  // The route sits under the public /api/auth prefix, so it checks the
  // session itself and refuses with the gate's own answer.
  const sessionId = sessionCookieOf(req);
  if (sessionId === undefined || store.session(sessionId) === undefined) {
    sendJson(res, 401, { error: "sign in required" });
    return true;
  }
  const body = await readJsonBody<{ current?: string; next?: string }>(req);
  if ((body.next ?? "").length < 8) {
    sendJson(res, 400, { error: "use at least 8 characters for the new passcode" });
    return true;
  }
  const outcome = store.changePasscode(body.current ?? "", body.next ?? "", sessionId);
  if (outcome === "locked") {
    record("passcode-change", false, "refused: throttled");
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
    record("passcode-change", false, "wrong passcode");
    sendJson(res, 401, { error: "wrong passcode" });
    return true;
  }
  record("passcode-change", true);
  sendJson(res, 200, { ok: true });
  return true;
};
