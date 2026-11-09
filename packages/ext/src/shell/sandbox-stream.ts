/**
 * A long-running exec in a microVM whose stdout streams while it lives and
 * whose stdin the caller writes: the browser cast and the browser broker's
 * large requests ride it. As the bot's own user (`user`) for anything the
 * bot owns, or as root (`undefined`) for the broker's door — bots never
 * reach the broker, the server does.
 */
import type { Sandbox } from "microsandbox";
import type { ShellStream } from "./backend.ts";
import type { SandboxUser } from "../plugins/vault.ts";
import { applyBotExec } from "./vm-provision.ts";

export const sandboxStream = async (
  sandbox: Sandbox,
  script: string,
  cwd: string,
  timeoutMs: number,
  user: SandboxUser | undefined,
): Promise<ShellStream> => {
  // An explicit stdin pipe: the default stdin is null, and a sink over a
  // null stdin writes nowhere.
  const handle = await sandbox.execStreamWith("bash", (b) => {
    const shaped = applyBotExec(b, script, cwd, timeoutMs, user) as {
      stdinPipe?: () => unknown;
    };
    shaped.stdinPipe?.();
    return shaped as never;
  });
  const sink = await handle.takeStdin();
  const chunkers: ((chunk: { stdout: boolean; data: Uint8Array }) => void)[] = [];
  const exiters: ((code: number) => void)[] = [];
  let exited = false;
  const finish = (code: number): void => {
    if (exited) return;
    exited = true;
    for (const exit of exiters) exit(code);
  };
  // The handle is push-less: only iterating produces the events.
  void (async () => {
    try {
      for await (const event of handle) {
        if (event.kind === "stdout") {
          for (const emit of chunkers) emit({ stdout: true, data: event.data });
        } else if (event.kind === "stderr") {
          for (const emit of chunkers) emit({ stdout: false, data: event.data });
        } else if (event.kind === "exited") finish(event.code);
      }
    } catch {
      finish(-1);
    }
  })();
  return {
    onChunk: (listener) => chunkers.push(listener),
    onExit: (listener) => exiters.push(listener),
    write: async (data) => {
      if (sink !== null) await sink.write(data);
    },
    stop: async () => {
      await sink?.close().catch(() => undefined);
      await handle.kill().catch(() => undefined);
      await handle[Symbol.asyncDispose]().catch(() => undefined);
    },
  };
};
