/**
 * The agent's running scripts, by exec id: start one inside the roots
 * (refused with an error frame when its start directory is outside them),
 * answer with its result, kill one on `cancel` (a cancelled exec answers
 * nothing), and kill them all when the agent stops.
 */
import type { NodeAgentInbound, NodeAgentOutbound } from "@spriessen/contracts";
import { confine } from "./confine.ts";
import { runScript, type RunningScript } from "./run-script.ts";

export interface Execs {
  readonly start: (
    frame: Extract<NodeAgentOutbound, { type: "exec" }>,
    roots: readonly string[],
  ) => void;
  readonly cancel: (id: string) => void;
  readonly killAll: () => void;
}

export const createExecs = (options: {
  readonly reply: (message: NodeAgentInbound) => void;
  readonly secret: string;
  readonly bashPath?: string | undefined;
}): Execs => {
  const running = new Map<string, RunningScript>();
  return {
    start: (frame, roots) => {
      let cwd: string;
      try {
        cwd = confine(roots, frame.cwd);
      } catch (cause) {
        options.reply({ type: "error", id: frame.id, message: String(cause) });
        return;
      }
      const script = runScript({
        script: frame.script,
        cwd,
        timeoutMs: frame.timeoutMs,
        secret: options.secret,
        ...(options.bashPath !== undefined ? { bashPath: options.bashPath } : {}),
      });
      running.set(frame.id, script);
      script.result.then(
        (result) => {
          if (running.delete(frame.id)) options.reply({ type: "result", id: frame.id, ...result });
        },
        (cause: unknown) => {
          if (running.delete(frame.id))
            options.reply({
              type: "error",
              id: frame.id,
              message: `the agent could not run the script: ${String(cause)}`,
            });
        },
      );
    },
    cancel: (id) => {
      const script = running.get(id);
      running.delete(id); // a cancelled exec sends nothing back
      script?.kill();
    },
    killAll: () => {
      for (const script of running.values()) script.kill();
      running.clear();
    },
  };
};
