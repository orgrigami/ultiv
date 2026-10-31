/**
 * Sign-in state for the client: one status read and the three calls the
 * passcode flow needs. A 401 from any API call raises the window event the
 * sign-in gate listens for, so an expired session lands back on sign-in
 * without a poll.
 */
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";

export interface AuthStatus {
  passcodeSet: boolean;
  bootstrap: boolean;
  session: boolean;
  passkeys: boolean;
}

/** Any API 401 raises this window event (see api.ts). */
export const UNAUTHORIZED_EVENT = "spriessen:unauthorized";

export const authStatus = async (): Promise<AuthStatus> => {
  const response = await fetch("/api/auth/status");
  if (!response.ok) throw new Error(`status ${response.status}`);
  return (await response.json()) as AuthStatus;
};

const post = async (
  path: string,
  body: unknown,
): Promise<{ ok: boolean; error: string | null }> => {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.ok) return { ok: true, error: null };
  const detail = (await response.json().catch(() => null)) as { error?: string } | null;
  return { ok: false, error: detail?.error ?? `failed (${response.status})` };
};

export const setPasscode = (passcode: string): Promise<{ ok: boolean; error: string | null }> =>
  post("/api/auth/passcode", { passcode });

export const signIn = (passcode: string): Promise<{ ok: boolean; error: string | null }> =>
  post("/api/auth/sign-in", { passcode });

export const signOut = (): Promise<void> =>
  fetch("/api/auth/sign-out", { method: "POST" }).then(() => undefined);

/** Passkey list row (Settings). */
export interface PasskeyRow {
  id: string;
  createdAt: number;
}

const postJson = async (
  path: string,
  body: unknown,
): Promise<{ ok: boolean; error: string | null }> => {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.ok) return { ok: true, error: null };
  const detail = (await response.json().catch(() => null)) as { error?: string } | null;
  return { ok: false, error: detail?.error ?? `failed (${response.status})` };
};

/** Options + token pairs the browser flow needs. */
interface OptionsReply {
  options: Record<string, unknown>;
  token: string;
}

const options = async (path: string): Promise<OptionsReply> => {
  const response = await fetch(path, { method: "POST" });
  if (!response.ok)
    throw new Error(
      ((await response.json().catch(() => null)) as { error?: string })?.error ?? "not available",
    );
  return (await response.json()) as OptionsReply;
};

export const passkeys = (): Promise<PasskeyRow[]> =>
  fetch("/api/auth/passkeys").then(async (response) =>
    response.ok ? ((await response.json()) as PasskeyRow[]) : [],
  );

export const removePasskey = (id: string): Promise<boolean> =>
  fetch(`/api/auth/passkeys/${encodeURIComponent(id)}`, { method: "DELETE" }).then(
    (response) => response.ok,
  );

/** Add a passkey to the signed-in account (the browser asks the authenticator). */
export const addPasskey = async (): Promise<{ ok: boolean; error: string | null }> => {
  const { options: creation, token } = await options("/api/auth/passkey/register-options");
  const attestation = await startRegistration({ optionsJSON: creation as never });
  return postJson("/api/auth/passkey/register", { token, response: attestation });
};

/** Sign in with a passkey (the browser asks the authenticator). */
export const signInWithPasskey = async (): Promise<{ ok: boolean; error: string | null }> => {
  const { options: request, token } = await options("/api/auth/passkey/auth-options");
  const assertion = await startAuthentication({ optionsJSON: request as never });
  return postJson("/api/auth/passkey/auth", { token, response: assertion });
};
