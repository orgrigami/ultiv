/**
 * The auth store: the passcode hash (scrypt), sign-in throttle state, and the
 * server-side session list behind the cookie. One JSON file each under
 * AUTH_DIR, written atomically with 0600, loaded lazily and kept in memory.
 * Failures to persist throw loudly here: unlike the audit, auth must gate.
 */
import { randomBytes, scryptSync, timingSafeEqual, type BinaryLike } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  LOCK_BASE_MS,
  LOCK_MAX_MS,
  LOCK_THRESHOLD,
  MAX_SESSIONS,
  SESSION_TTL_MS,
  authDir,
} from "./config.ts";

export interface SessionRow {
  readonly createdAt: number;
  lastSeenAt: number;
}

interface AuthFile {
  passcodeHash: string | null;
  failCount: number;
  lockedUntil: number;
  /** Passkey credentials (slice 11); empty until one is registered. */
  passkeys: PasskeyRow[];
}

/** One registered passkey (WebAuthn credential). */
export interface PasskeyRow {
  readonly id: string;
  publicKey: string;
  counter: number;
  /** The rp ID (host) the passkey was registered on. */
  readonly rpId: string;
  createdAt: number;
  lastUsedAt: number;
}

const emptyAuth = (): AuthFile => ({
  passcodeHash: null,
  failCount: 0,
  lockedUntil: 0,
  passkeys: [],
});

const scryptOf = (secret: BinaryLike, salt: Buffer): Buffer =>
  scryptSync(secret, salt, 32, { N: 16384, r: 8, p: 1 });

/** `scrypt$N$r$p$<salt b64url>$<hash b64url>` — verify with timingSafeEqual. */
export const hashPasscode = (passcode: string): string => {
  const salt = randomBytes(16);
  const hash = scryptOf(passcode, salt);
  return `scrypt$16384$8$1$${salt.toString("base64url")}$${hash.toString("base64url")}`;
};

const hashParts = (stored: string): { salt: Buffer; hash: Buffer } | undefined => {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return undefined;
  const salt = Buffer.from(parts[4] ?? "", "base64url");
  const hash = Buffer.from(parts[5] ?? "", "base64url");
  if (salt.length === 0 || hash.length === 0) return undefined;
  return { salt, hash };
};

export const verifyPasscodeHash = (passcode: string, stored: string): boolean => {
  const parts = hashParts(stored);
  if (parts === undefined) return false;
  const attempt = scryptOf(passcode, parts.salt);
  return attempt.length === parts.hash.length && timingSafeEqual(attempt, parts.hash);
};

const readJson = <T>(path: string, fallback: T): T => {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
};

const writeJson = (path: string, value: unknown): void => {
  mkdirSync(authDir(), { recursive: true, mode: 0o700 });
  const temp = join(
    authDir(),
    `.${path.split("/").pop() ?? "file"}.${randomBytes(4).toString("hex")}`,
  );
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  renameSync(temp, path);
};

export type AttemptOutcome = "ok" | "wrong" | "locked";

const mtimeOf = (path: string): number => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
};

export class AuthStore {
  private file: AuthFile = emptyAuth();
  private sessions = new Map<string, SessionRow>();
  private seen = { auth: -1, sessions: -1 };
  private readonly authPath = join(authDir(), "auth.json");
  private readonly sessionsPath = join(authDir(), "sessions.json");

  private load(): void {
    // Re-read when the files changed on disk, so the recovery command (a
    // separate process) takes effect on a running server without a restart.
    const auth = mtimeOf(this.authPath);
    const sessions = mtimeOf(this.sessionsPath);
    if (auth === this.seen.auth && sessions === this.seen.sessions) return;
    this.seen = { auth, sessions };
    this.file = { ...emptyAuth(), ...readJson<Partial<AuthFile>>(this.authPath, {}) };
    this.sessions = new Map();
    const rows = readJson<Record<string, SessionRow>>(this.sessionsPath, {});
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [id, row] of Object.entries(rows)) {
      if (row.lastSeenAt >= cutoff) this.sessions.set(id, row);
    }
  }

  private persistAuth(): void {
    writeJson(this.authPath, this.file);
  }

  private persistSessions(): void {
    const rows: Record<string, SessionRow> = {};
    for (const [id, row] of this.sessions) rows[id] = row;
    writeJson(this.sessionsPath, rows);
  }

  get passcodeSet(): boolean {
    this.load();
    return this.file.passcodeHash !== null;
  }

  /** First-time setup only: the passcode must not exist yet. */
  setPasscode(passcode: string): void {
    this.load();
    if (this.file.passcodeHash !== null) throw new Error("passcode already set");
    this.file = {
      ...this.file,
      passcodeHash: hashPasscode(passcode),
      failCount: 0,
      lockedUntil: 0,
    };
    this.persistAuth();
  }

  /**
   * Requires the current passcode, checked under the sign-in throttle (so
   * the change form is no side door for guessing). A change signs out every
   * other session: whoever learned the old passcode loses access with it.
   */
  changePasscode(current: string, next: string, keepSessionId?: string): AttemptOutcome {
    const outcome = this.attempt(current);
    if (outcome !== "ok") return outcome;
    this.file = { ...this.file, passcodeHash: hashPasscode(next) };
    this.persistAuth();
    for (const id of [...this.sessions.keys()]) {
      if (id !== keepSessionId) this.sessions.delete(id);
    }
    this.persistSessions();
    return "ok";
  }

  /**
   * One sign-in attempt under the throttle: `locked` while waiting, `wrong`
   * counts toward the next lock, `ok` clears both.
   */
  attempt(passcode: string): AttemptOutcome {
    this.load();
    if (this.file.passcodeHash === null) return "wrong";
    const now = Date.now();
    if (this.file.lockedUntil > now) return "locked";
    if (!verifyPasscodeHash(passcode, this.file.passcodeHash)) {
      const failCount = this.file.failCount + 1;
      const wait =
        failCount < LOCK_THRESHOLD
          ? 0
          : Math.min(LOCK_BASE_MS * 2 ** (failCount - LOCK_THRESHOLD), LOCK_MAX_MS);
      this.file = {
        ...this.file,
        failCount,
        lockedUntil: wait > 0 ? now + wait : this.file.lockedUntil,
      };
      this.persistAuth();
      return "wrong";
    }
    this.file = { ...this.file, failCount: 0, lockedUntil: 0 };
    this.persistAuth();
    return "ok";
  }

  /** Seconds until the throttle lifts (0 when not locked). */
  lockedFor(): number {
    this.load();
    return Math.max(0, Math.ceil((this.file.lockedUntil - Date.now()) / 1000));
  }

  createSession(): string {
    this.load();
    const id = randomBytes(32).toString("base64url");
    if (this.sessions.size >= MAX_SESSIONS) {
      const oldest = [...this.sessions.entries()].sort(
        (a, b) => a[1].lastSeenAt - b[1].lastSeenAt,
      )[0];
      if (oldest !== undefined) this.sessions.delete(oldest[0]);
    }
    const now = Date.now();
    this.sessions.set(id, { createdAt: now, lastSeenAt: now });
    this.persistSessions();
    return id;
  }

  /** Valid session reads slide the expiry forward; expired ids are dropped. */
  session(id: string): SessionRow | undefined {
    this.load();
    const row = this.sessions.get(id);
    if (row === undefined) return undefined;
    const now = Date.now();
    if (now - row.lastSeenAt > SESSION_TTL_MS) {
      this.sessions.delete(id);
      this.persistSessions();
      return undefined;
    }
    // Sliding expiry, but at most one disk write a minute per session.
    if (now - row.lastSeenAt > 60_000) {
      row.lastSeenAt = now;
      this.persistSessions();
    } else {
      row.lastSeenAt = now;
    }
    return row;
  }

  deleteSession(id: string): void {
    this.load();
    if (!this.sessions.delete(id)) return;
    this.persistSessions();
  }

  /** The recovery path: a new passcode and no sessions left standing. */
  reset(passcode: string): void {
    this.load();
    this.sessions.clear();
    this.file = {
      ...this.file,
      passcodeHash: hashPasscode(passcode),
      failCount: 0,
      lockedUntil: 0,
    };
    this.persistAuth();
    this.persistSessions();
  }

  passkeys(): readonly PasskeyRow[] {
    this.load();
    return this.file.passkeys;
  }

  upsertPasskey(row: PasskeyRow): void {
    this.load();
    const rest = this.file.passkeys.filter((key) => key.id !== row.id);
    this.file = { ...this.file, passkeys: [...rest, row] };
    this.persistAuth();
  }

  removePasskey(id: string): boolean {
    this.load();
    const rest = this.file.passkeys.filter((key) => key.id !== id);
    if (rest.length === this.file.passkeys.length) return false;
    this.file = { ...this.file, passkeys: rest };
    this.persistAuth();
    return true;
  }
}

/** A fresh store in a throwaway dir; the caller owns the dir's cleanup. */
export const scratchAuthStore = (dir: string): AuthStore => {
  mkdirSync(dir, { recursive: true });
  const previous = process.env.AUTH_DIR;
  process.env.AUTH_DIR = dir;
  const store = new AuthStore();
  if (previous === undefined) delete process.env.AUTH_DIR;
  else process.env.AUTH_DIR = previous;
  return store;
};
