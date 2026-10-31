/**
 * Sign-in state for the client: one status read, the passcode and passkey
 * calls, each answering one readable line on failure (never a throw). A 401 from any API call raises the window event the
 * sign-in gate listens for, so an expired session lands back on sign-in
 * without a poll.
 */
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { authErrorText, passkeyErrorText } from "./auth-text.ts";

export interface AuthStatus {
  passcodeSet: boolean;
  bootstrap: boolean;
  session: boolean;
  passkeys: boolean;
}

/** Any API 401 raises this window event (see api.ts). */
export const UNAUTHORIZED_EVENT = "spriessen:unauthorized";

/** Every state change names JSON; the server refuses typeless posts. */
const JSON_TYPE = { "content-type": "application/json" };

export const authStatus = async (): Promise<AuthStatus> => {
  const response = await fetch("/api/auth/status");
  if (!response.ok) throw new Error(`status ${response.status}`);
  return (await response.json()) as AuthStatus;
};

export type AuthResult = { ok: boolean; error: string | null };

const UNREACHABLE = "The server isn't reachable right now.";

const post = async (path: string, body?: unknown): Promise<AuthResult> => {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: JSON_TYPE,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    return { ok: false, error: UNREACHABLE };
  }
  if (response.ok) return { ok: true, error: null };
  const detail = (await response.json().catch(() => null)) as { error?: string } | null;
  return {
    ok: false,
    error: authErrorText(response.status, detail?.error, response.headers.get("retry-after")),
  };
};

export const setPasscode = (passcode: string): Promise<AuthResult> =>
  post("/api/auth/passcode", { passcode });

export const signIn = (passcode: string): Promise<AuthResult> =>
  post("/api/auth/sign-in", { passcode });

export const signOut = (): Promise<AuthResult> => post("/api/auth/sign-out");

/** Passkey list row (Settings). */
export interface PasskeyRow {
  id: string;
  createdAt: number;
}

/** Options + token pairs the browser flow needs. */
interface OptionsReply {
  options: Record<string, unknown>;
  token: string;
}

const options = async (path: string): Promise<OptionsReply> => {
  const response = await fetch(path, { method: "POST", headers: JSON_TYPE });
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(
      authErrorText(response.status, detail?.error, response.headers.get("retry-after")),
    );
  }
  return (await response.json()) as OptionsReply;
};

/** The passkeys on this server; throws when they can't be read. */
export const passkeys = async (): Promise<PasskeyRow[]> => {
  const response = await fetch("/api/auth/passkeys");
  if (!response.ok) throw new Error(`passkeys ${response.status}`);
  return (await response.json()) as PasskeyRow[];
};

export const removePasskey = async (id: string): Promise<boolean> => {
  try {
    const response = await fetch(`/api/auth/passkeys/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    return response.ok && ((await response.json()) as { ok?: boolean }).ok === true;
  } catch {
    return false;
  }
};

/** Whether this page can use passkeys at all (WebAuthn needs a secure origin). */
export const passkeysSupported = (): boolean =>
  typeof window !== "undefined" &&
  window.isSecureContext &&
  typeof window.PublicKeyCredential === "function";

/** Run one browser passkey ceremony; never throws, always one readable line. */
const ceremony = async (run: () => Promise<AuthResult>): Promise<AuthResult> => {
  try {
    return await run();
  } catch (cause) {
    return { ok: false, error: passkeyErrorText(cause) };
  }
};

/** Add a passkey to the signed-in account (the browser asks the authenticator). */
export const addPasskey = (): Promise<AuthResult> =>
  ceremony(async () => {
    const { options: creation, token } = await options("/api/auth/passkey/register-options");
    const attestation = await startRegistration({ optionsJSON: creation as never });
    return post("/api/auth/passkey/register", { token, response: attestation });
  });

/** Sign in with a passkey (the browser asks the authenticator). */
export const signInWithPasskey = (): Promise<AuthResult> =>
  ceremony(async () => {
    const { options: request, token } = await options("/api/auth/passkey/auth-options");
    const assertion = await startAuthentication({ optionsJSON: request as never });
    return post("/api/auth/passkey/auth", { token, response: assertion });
  });
