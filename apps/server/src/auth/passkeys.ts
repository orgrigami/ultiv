/**
 * Passkey sign-in (WebAuthn) beside the passcode. Registration happens while
 * signed in; authentication is public like the passcode sign-in and issues
 * the same session cookie. The rp id and origin come from the request's own
 * Host (the page's origin), so the tailnet HTTPS facet and localhost each
 * register working passkeys. Challenges live in memory for 120 s, keyed by a
 * token the client echoes back; the credentials live in the auth store.
 */
import { randomBytes } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { IncomingMessage } from "node:http";
import type { AuthStore } from "./store.ts";

/** The relying party shown in the browser's sheet. */
const RP_NAME = "Spriessen";

const challenges = new Map<string, { challenge: string; expiresAt: number }>();

const remember = (challenge: string): string => {
  const token = randomBytes(16).toString("base64url");
  const now = Date.now();
  for (const [id, entry] of challenges) if (entry.expiresAt < now) challenges.delete(id);
  challenges.set(token, { challenge, expiresAt: now + 120_000 });
  return token;
};

const take = (token: string): string | null => {
  const entry = challenges.get(token);
  challenges.delete(token);
  if (entry === undefined || entry.expiresAt < Date.now()) return null;
  return entry.challenge;
};

/** The page's rp id (hostname) and origin, from the request itself. */
export const rpOf = (req: IncomingMessage): { rpId: string; origin: string } => {
  const host = req.headers.host ?? "localhost";
  const proto =
    req.headers["x-forwarded-proto"] === "https" ||
    (req.socket as { encrypted?: boolean }).encrypted === true
      ? "https"
      : "http";
  return { rpId: host.split(":")[0] ?? "localhost", origin: `${proto}://${host}` };
};

/** Options for adding a passkey (the caller is signed in), with its token. */
export const registrationOptionsFor = async (
  req: IncomingMessage,
  store: AuthStore,
): Promise<{ options: PublicKeyCredentialCreationOptionsJSON; token: string }> => {
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rpOf(req).rpId,
    userName: "owner",
    userDisplayName: "Spriessen owner",
    excludeCredentials: store.passkeys().map((key) => ({ id: key.id })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
  });
  return { options, token: remember(options.challenge) };
};

/** Verify a registration and store the credential. */
export const registerPasskey = async (
  req: IncomingMessage,
  store: AuthStore,
  token: string,
  body: RegistrationResponseJSON,
): Promise<{ ok: boolean; error: string | null }> => {
  const challenge = take(token);
  if (challenge === null) return { ok: false, error: "start again: the request expired" };
  const { rpId, origin } = rpOf(req);
  try {
    const result = await verifyRegistrationResponse({
      response: body,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpId,
      requireUserVerification: false,
    });
    if (!result.verified || result.registrationInfo === undefined) {
      return { ok: false, error: "the authenticator could not be verified" };
    }
    const { credential } = result.registrationInfo;
    store.upsertPasskey({
      id: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString("base64url"),
      counter: credential.counter,
      rpId,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    });
    return { ok: true, error: null };
  } catch {
    return { ok: false, error: "the authenticator could not be verified" };
  }
};

/** Options for signing in: any stored passkey for this rp may answer. */
export const authenticationOptionsFor = async (
  req: IncomingMessage,
  store: AuthStore,
): Promise<{ options: PublicKeyCredentialRequestOptionsJSON; token: string }> => {
  const options = await generateAuthenticationOptions({
    rpID: rpOf(req).rpId,
    userVerification: "preferred",
    allowCredentials: store
      .passkeys()
      .filter((key) => key.rpId === rpOf(req).rpId)
      .map((key) => ({ id: key.id })),
  });
  return { options, token: remember(options.challenge) };
};

/** Verify a sign-in assertion; true means the caller may have a session. */
export const verifyPasskeySignIn = async (
  req: IncomingMessage,
  store: AuthStore,
  token: string,
  body: AuthenticationResponseJSON,
): Promise<boolean> => {
  const challenge = take(token);
  if (challenge === null) return false;
  const key = store.passkeys().find((candidate) => candidate.id === body.id);
  if (key === undefined) return false;
  const { rpId, origin } = rpOf(req);
  try {
    const result = await verifyAuthenticationResponse({
      response: body,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpId,
      credential: {
        id: key.id,
        publicKey: Buffer.from(key.publicKey, "base64url"),
        counter: key.counter,
      },
      requireUserVerification: false,
    });
    if (!result.verified) return false;
    store.upsertPasskey({
      ...key,
      counter: result.authenticationInfo.newCounter,
      lastUsedAt: Date.now(),
    });
    return true;
  } catch {
    return false;
  }
};
