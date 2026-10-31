/**
 * Sign-in state for the client: one status read and the three calls the
 * passcode flow needs. A 401 from any API call raises the window event the
 * sign-in gate listens for, so an expired session lands back on sign-in
 * without a poll.
 */
export interface AuthStatus {
  passcodeSet: boolean;
  bootstrap: boolean;
  session: boolean;
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
