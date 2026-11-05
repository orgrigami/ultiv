/**
 * Where Spriessen keeps everything that is not code: ONE home folder,
 * `$SPRIESSEN_HOME` or `~/.spriessen`.
 *
 *   ~/.spriessen/data     the server's data (was `var/` beside the server):
 *                         harness.sqlite, search.sqlite, auth/, vault/,
 *                         artifacts/, bot-files/, skills/, mcp/, push/,
 *                         audit.jsonl and the model catalog caches
 *   ~/.spriessen/config   the CLI's sign-in and node token (0600)
 *   ~/.spriessen/.env     the keys `serve` and the daemon load
 *   ~/.spriessen/logs     daemon logs where the OS keeps none (macOS)
 *
 * `SPRIESSEN_DATA_DIR` moves the data folder; every per-item env key
 * (`HARNESS_DB`, `VAULT_DIR`, `ARTIFACTS_DIR`, …) still wins for its item.
 *
 * An existing install keeps working untouched: while `./var/harness.sqlite`
 * exists (beside the running server) and the home has no data yet, the
 * defaults stay EXACTLY the old relative `var/…` paths — the strings matter,
 * because each bot's microVM name hashes its folder path as written. One
 * warning per process points at `spriessen data move`.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const LEGACY = "var";
let warned = false;

const setting = (env: NodeJS.ProcessEnv, key: string): string | undefined => {
  const value = env[key]?.trim();
  return value === undefined || value === "" ? undefined : value;
};

/** The home folder: `$SPRIESSEN_HOME`, else `~/.spriessen`. */
export const spriessenHome = (env: NodeJS.ProcessEnv = process.env): string =>
  resolve(setting(env, "SPRIESSEN_HOME") ?? join(homedir(), ".spriessen"));

/** `./var` still holds the data and the home does not: the pre-home layout. */
export const usesLegacyData = (
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): boolean =>
  setting(env, "SPRIESSEN_DATA_DIR") === undefined &&
  !existsSync(join(spriessenHome(env), "data", "harness.sqlite")) &&
  existsSync(join(cwd, LEGACY, "harness.sqlite"));

/** The data folder (see the module comment for the order). */
export const dataDir = (
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string => {
  const configured = setting(env, "SPRIESSEN_DATA_DIR");
  if (configured !== undefined) return resolve(configured);
  if (usesLegacyData(env, cwd)) {
    if (!warned && env === process.env) {
      warned = true;
      console.warn(
        `data: still using the old data folder ${resolve(cwd, LEGACY)}. ` +
          "Move it into ~/.spriessen/data with `spriessen data move` (stop the server first).",
      );
    }
    return LEGACY;
  }
  return join(spriessenHome(env), "data");
};

/** One item inside the data folder: the default for its env key. */
export const dataPath = (...parts: readonly string[]): string => join(dataDir(), ...parts);
