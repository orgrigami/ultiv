/**
 * Auth configuration: where the passcode hash, sessions and passkeys live,
 * and the cookie/session constants. One module so a later change (TTL, name,
 * folder) has one place to edit.
 */
import { join } from "node:path";

export const authDir = (): string => {
  const configured = process.env.AUTH_DIR?.trim();
  return configured !== undefined && configured !== "" ? configured : join("var", "auth");
};

/** The sign-in session cookie. HttpOnly, SameSite=Strict, Secure over HTTPS. */
export const SESSION_COOKIE = "spriessen_session";

/** Sliding sign-in session lifetime: use refreshes it, idleness expires it. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Kept sessions per install; creating more drops the least recently used. */
export const MAX_SESSIONS = 100;

/** Body cap for the pre-auth routes (status, sign-in, set passcode). */
export const AUTH_BODY_LIMIT = 16 * 1024;

/**
 * Sign-in throttle: the first failures answer at once; from the fifth the
 * attempt locks for a doubling wait, capped at 15 minutes.
 */
export const LOCK_THRESHOLD = 5;
export const LOCK_BASE_MS = 30_000;
export const LOCK_MAX_MS = 15 * 60_000;
