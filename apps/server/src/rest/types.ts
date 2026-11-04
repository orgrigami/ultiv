/** Shared REST plumbing: route args and body/query helpers. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { MindService } from "@spriessen/mind";
import type { CronScheduler } from "../cron.ts";
import type { PushService } from "../push/index.ts";

/** The live node dials, as the REST routes reach them (main.ts's agent endpoint). */
export interface NodeLinks {
  readonly drop: (nodeId: string) => void;
  readonly pushRoots: (nodeId: string, roots: readonly string[]) => void;
  readonly connected: (nodeId: string) => boolean;
}

export interface RouteArgs {
  readonly mind: MindService;
  readonly scheduler: CronScheduler;
  /** Web Push; absent in stacks built without it (tests). */
  readonly push?: PushService;
  /** The /agent endpoint's dial registry; revocation kills the live connection. */
  readonly nodes?: NodeLinks;
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  readonly owner: string;
  readonly path: string;
  readonly json: (status: number, body: unknown) => void;
  readonly readJson: <T>(req: IncomingMessage) => Promise<T>;
  readonly readBody: (req: IncomingMessage) => Promise<Buffer>;
}

export const queryOr = (args: RouteArgs, key: string): string | undefined => {
  const value = args.url.searchParams.get(key);
  return value !== null && value.trim() !== "" ? value : undefined;
};

export const errorOf = (cause: unknown): string => {
  const error = cause as { reason?: string; what?: string };
  return error.reason ?? error.what ?? String(cause);
};
