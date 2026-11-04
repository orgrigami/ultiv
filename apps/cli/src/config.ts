/**
 * Where the CLI keeps what it remembers, all under one folder
 * (`$SPRIESSEN_CONFIG_DIR`, else `$XDG_CONFIG_HOME/spriessen`, else
 * `~/.config/spriessen`, mode 0700):
 *
 * - `credentials.json` (0600): the server origin and the sign-in session
 *   cookie the passcode sign-in returned — the same session a browser holds,
 *   30 days sliding. Never printed.
 * - `node-token` (0600): this machine's pairing token when it runs as a node.
 *
 * Which server: `--server`, then `SPRIESSEN_SERVER_URL`, then the saved one,
 * then `http://127.0.0.1:8787` (the default port, this machine).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_SERVER = "http://127.0.0.1:8787";

export interface Credentials {
  readonly server: string;
  /** `name=value`, exactly as the Cookie header carries it. */
  readonly cookie: string;
  readonly savedAt: number;
}

export const configDir = (env: NodeJS.ProcessEnv = process.env): string => {
  if (env["SPRIESSEN_CONFIG_DIR"]) return env["SPRIESSEN_CONFIG_DIR"];
  const base = env["XDG_CONFIG_HOME"] || join(homedir(), ".config");
  return join(base, "spriessen");
};

const ensureDir = (dir: string): string => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
};

/** Write a private file: 0600, whatever the umask. */
export const writePrivate = (path: string, text: string): void => {
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
};

export const credentialsPath = (env?: NodeJS.ProcessEnv): string =>
  join(configDir(env), "credentials.json");

export const nodeTokenPath = (env?: NodeJS.ProcessEnv): string =>
  join(configDir(env), "node-token");

export const readCredentials = (env?: NodeJS.ProcessEnv): Credentials | undefined => {
  const path = credentialsPath(env);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Credentials>;
    if (typeof parsed.server !== "string" || typeof parsed.cookie !== "string") return undefined;
    return { server: parsed.server, cookie: parsed.cookie, savedAt: parsed.savedAt ?? 0 };
  } catch {
    return undefined;
  }
};

export const saveCredentials = (credentials: Credentials, env?: NodeJS.ProcessEnv): void => {
  ensureDir(configDir(env));
  writePrivate(credentialsPath(env), `${JSON.stringify(credentials, null, 2)}\n`);
};

export const forgetCredentials = (env?: NodeJS.ProcessEnv): boolean => {
  const path = credentialsPath(env);
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
};

export const saveNodeToken = (token: string, env?: NodeJS.ProcessEnv): string => {
  ensureDir(configDir(env));
  const path = nodeTokenPath(env);
  writePrivate(path, `${token}\n`);
  return path;
};

/** `http(s)://host[:port]` without a trailing slash; a bare host:port gets http://. */
export const normalizeServer = (value: string): string => {
  const trimmed = value.trim().replace(/\/+$/, "");
  return /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
};

export const serverOf = (flag: string | undefined, env: NodeJS.ProcessEnv = process.env): string =>
  normalizeServer(
    flag ?? (env["SPRIESSEN_SERVER_URL"] || readCredentials(env)?.server || DEFAULT_SERVER),
  );
