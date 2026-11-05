/**
 * Where the CLI keeps what it remembers, all under one folder
 * (`$SPRIESSEN_CONFIG_DIR`, else `config/` in the Spriessen home —
 * `~/.spriessen/config`, mode 0700; core home.ts). A folder from before the
 * home (`~/.config/spriessen`) moves there on first use and leaves a
 * symlink behind, so a daemon unit that names the old token path still works:
 *
 * - `credentials.json` (0600): the server origin and the sign-in session
 *   cookie the passcode sign-in returned — the same session a browser holds,
 *   30 days sliding. Never printed.
 * - `node-token` (0600): this machine's pairing token when it runs as a node.
 *
 * Which server: `--server`, then `SPRIESSEN_SERVER_URL`, then the saved one,
 * then `http://127.0.0.1:8787` (the default port, this machine).
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spriessenHome } from "@spriessen/core";

export const DEFAULT_SERVER = "http://127.0.0.1:8787";

export interface Credentials {
  readonly server: string;
  /** `name=value`, exactly as the Cookie header carries it. */
  readonly cookie: string;
  readonly savedAt: number;
}

/** Where the config lived before the home: `$XDG_CONFIG_HOME/spriessen` or `~/.config/spriessen`. */
export const legacyConfigDir = (env: NodeJS.ProcessEnv = process.env): string =>
  join(env["XDG_CONFIG_HOME"] || join(homedir(), ".config"), "spriessen");

/** Move a pre-home config folder into the home once, leaving a symlink where it was. */
const adoptLegacy = (target: string, env: NodeJS.ProcessEnv): void => {
  const legacy = legacyConfigDir(env);
  if (existsSync(target) || !existsSync(legacy) || lstatSync(legacy).isSymbolicLink()) return;
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  renameSync(legacy, target);
  symlinkSync(target, legacy);
};

export const configDir = (env: NodeJS.ProcessEnv = process.env): string => {
  if (env["SPRIESSEN_CONFIG_DIR"]) return env["SPRIESSEN_CONFIG_DIR"];
  const dir = join(spriessenHome(env), "config");
  try {
    adoptLegacy(dir, env);
  } catch {
    // A move that fails (another filesystem, permissions) leaves the old folder in use.
    if (!existsSync(dir) && existsSync(legacyConfigDir(env))) return legacyConfigDir(env);
  }
  return dir;
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
