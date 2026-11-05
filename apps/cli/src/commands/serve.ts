/**
 * `spriessen serve`: the whole app in one foreground process — the server
 * stack plus the built web app (apps/web/dist) on one port. Data lives in
 * the Spriessen home (`~/.spriessen/data`, core home.ts; `--data` moves it);
 * an install that still has its old `apps/server/var/` keeps using that until
 * `spriessen data move`, which is why serve still runs from the server's
 * folder. Keys load from `~/.spriessen/.env`, else the checkout's `.env`
 * (`--env-file` names another). `--no-web` serves the API only.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir, spriessenHome } from "@spriessen/core";
import { boolFlag, numberFlag, stringFlag, type Parsed } from "../args.ts";

/** The server package's folder (apps/server), wherever the CLI runs from. */
export const serverDir = (): string =>
  dirname(dirname(fileURLToPath(import.meta.resolve("@spriessen/server"))));

/** The repo root: two up from the server package. */
export const repoRoot = (): string => resolve(serverDir(), "..", "..");

/** The built web app, or undefined when it was never built. */
export const webDistOf = (flag: string | undefined): string | undefined => {
  const dist = flag !== undefined ? resolve(flag) : join(repoRoot(), "apps", "web", "dist");
  return existsSync(join(dist, "index.html")) ? dist : undefined;
};

/** The env file serve loads: the flag, else the home's `.env`, else the checkout's. */
export const envFileOf = (flag: string | undefined): string | undefined => {
  if (flag !== undefined) return resolve(flag);
  return [join(spriessenHome(), ".env"), join(repoRoot(), ".env")].find((path) => existsSync(path));
};

/** Load the env file once, before the server reads any config. */
export const loadEnv = (flag: string | undefined): string | undefined => {
  const path = envFileOf(flag);
  if (path === undefined) return undefined;
  if (!existsSync(path)) throw new Error(`There's no env file at ${path}`);
  process.loadEnvFile(path);
  return path;
};

export const serveCommand = async (parsed: Parsed): Promise<void> => {
  const envFile = loadEnv(stringFlag(parsed, "env-file"));
  const webFlag = stringFlag(parsed, "web");
  const webDist = boolFlag(parsed, "no-web") ? undefined : webDistOf(webFlag);
  if (!boolFlag(parsed, "no-web") && webDist === undefined) {
    console.error("serve: no web build found (run: vp -C apps/web build); serving the API only");
  }
  const data = stringFlag(parsed, "data");
  if (data !== undefined) process.env["SPRIESSEN_DATA_DIR"] = resolve(data);
  process.chdir(serverDir());
  const port = numberFlag(parsed, "port");
  const host = stringFlag(parsed, "host");
  // Imported here: loading the server pulls in the whole mind, which the
  // client commands never need.
  const { serve } = await import("@spriessen/server");
  const server = await serve({
    ...(port !== undefined ? { port } : {}),
    ...(host !== undefined ? { host } : {}),
    ...(webDist !== undefined ? { webDist } : {}),
    log: (line) => console.log(line),
  });
  if (envFile !== undefined) console.log(`serve: env from ${envFile}`);
  console.log(
    `serve: data in ${resolve(dataDir())}${webDist !== undefined ? "; web app included" : ""}`,
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    // As the server's own entry does: once the stack has closed (links, the
    // mind's scope, the lock), exit — background handles must not keep a
    // stopped server's process alive.
    process.once(signal, () => {
      void server.close().then(() => process.exit(0));
    });
  }
  await new Promise<void>(() => undefined);
};
