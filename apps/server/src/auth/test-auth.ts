/** Test helper: sign in over the real handler and return the cookie pair. */
const json = async (base: string, path: string, body?: unknown) => {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  return { status: response.status, cookie };
};

/**
 * First sign-in for a test stack: sets the passcode (bootstrap) or signs in
 * when one is already set, and returns the `name=value` cookie pair.
 */
export const signInForTest = async (
  base: string,
  passcode = "test-passcode-1",
): Promise<string> => {
  const set = await json(base, "/api/auth/passcode", { passcode });
  if (set.status === 200 && set.cookie !== undefined) return set.cookie;
  const signIn = await json(base, "/api/auth/sign-in", { passcode });
  if (signIn.status !== 200 || signIn.cookie === undefined) {
    throw new Error(`test sign-in failed: set=${set.status} in=${signIn.status}`);
  }
  return signIn.cookie;
};
