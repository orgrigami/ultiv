/**
 * Start a whole server: take the data-folder lock, build the stack, listen.
 * The server's own entry (main.ts) and `spriessen serve` (through index.ts)
 * both come through here, so they listen, log and shut down the same way. `PORT`/`HOST` are the
 * defaults; unset HOST binds every interface, IPv4 AND IPv6 (Node's
 * dual-stack `::`), so localhost, the LAN and the tailnet all reach it.
 */
import { assertNodeVersion } from "@spriessen/core";
import { acquireDataLock, type DataLock } from "./data-lock.ts";
import { reachableUrls } from "./listen.ts";
// Type-only: main.ts imports this file (a runtime cycle would deadlock its top-level await).
import type { buildStack } from "./main.ts";

export interface StartOptions {
  readonly port?: number;
  /** Undefined binds every interface; a value narrows it. */
  readonly host?: string;
  /** Serve this web build too (apps/web/dist). */
  readonly webDist?: string;
  /** Skip the data-folder lock (never for a real data folder). */
  readonly unlocked?: boolean;
  readonly log?: (line: string) => void;
}

export interface RunningServer {
  readonly urls: readonly string[];
  readonly port: number;
  readonly stack: Awaited<ReturnType<typeof buildStack>>;
  readonly close: () => Promise<void>;
}

const envHost = (): string | undefined =>
  process.env["HOST"] === undefined || process.env["HOST"] === "" ? undefined : process.env["HOST"];

export const startServer = async (
  build: typeof buildStack,
  options: StartOptions = {},
): Promise<RunningServer> => {
  assertNodeVersion(options.log);
  const port = options.port ?? Number(process.env["PORT"] ?? 8787);
  const host = options.host ?? envHost();
  const lock: DataLock | undefined =
    options.unlocked === true ? undefined : await acquireDataLock();
  let stack: Awaited<ReturnType<typeof buildStack>>;
  try {
    stack = await build(options.webDist !== undefined ? { webDist: options.webDist } : {});
    await new Promise<void>((resolve, reject) => {
      stack.http.once("error", reject);
      if (host === undefined) stack.http.listen(port, resolve);
      else stack.http.listen(port, host, resolve);
    });
  } catch (cause) {
    lock?.release();
    throw cause;
  }
  const address = stack.http.address();
  const bound = typeof address === "object" && address !== null ? address.port : port;
  const urls = reachableUrls(stack.http, host);
  options.log?.(`spriessen server listening on ${urls.join("  ")}`);
  let closing: Promise<void> | undefined;
  return {
    urls,
    port: bound,
    stack,
    close: () => {
      closing ??= stack.close().finally(() => lock?.release());
      return closing;
    },
  };
};
