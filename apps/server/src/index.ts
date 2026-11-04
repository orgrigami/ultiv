/**
 * The server as a library (`spriessen serve`, the daemon): the same stack
 * and start path the server's own entry runs.
 */
import { buildStack } from "./main.ts";
import { startServer, type RunningServer, type StartOptions } from "./start.ts";

export { buildStack } from "./main.ts";
export { acquireDataLock, dataDirOf } from "./data-lock.ts";
export type { DataLock } from "./data-lock.ts";
export type { RunningServer, StartOptions } from "./start.ts";

/** Lock the data folder, build the whole stack and listen. */
export const serve = (options: StartOptions = {}): Promise<RunningServer> =>
  startServer(buildStack, options);
