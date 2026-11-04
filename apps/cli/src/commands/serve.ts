/**
 * `spriessen serve`: the whole app in one foreground process — the server
 * stack plus the built web app (apps/web/dist) on one port. It runs from the
 * server package's own folder, exactly like the server's `start` script,
 * so `var/` is the same data folder the dev server uses (and the data-folder
 * lock keeps the two from running at once); the repo's `.env` loads first
 * unless `--env-file` names another. `--no-web` serves the API only.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

/** Load the env file once, before the server reads any config. */
export const loadEnv = (flag: string | undefined): string | undefined => {
  const path = flag !== undefined ? resolve(flag) : join(repoRoot(), ".env");
  if (!existsSync(path)) {
    if (flag !== undefined) throw new Error(`no env file at ${path}`);
    return undefined;
  }
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
  process.chdir(stringFlag(parsed, "data") ?? serverDir());
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
    `serve: data in ${process.cwd()}/var${webDist !== undefined ? "; web app included" : ""}`,
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
