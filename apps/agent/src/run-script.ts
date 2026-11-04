/**
 * One exec on the node: `/bin/bash -c <script>` in its OWN process group, so
 * a timeout or a cancel kills everything the script started (`kill -pgid`),
 * not just bash. The answer is sent when BASH exits (plus a short drain for
 * output still in the pipes): a background job the script started
 * (`server &`) keeps the pipes open, and waiting for them to close would
 * hang the exec until that job ends. After the answer the pipes keep
 * draining into nothing, so a background job never dies of SIGPIPE.
 *
 * The child's environment never carries the pairing token (the agent's own
 * `SPRIESSEN_NODE_*` keys are dropped), and every answer is scrubbed of the
 * token's text: a script that runs `env` or reads the agent's command line
 * cannot carry the token into the bot's transcript by accident. A script
 * runs as the owner's own account, so it can still read what that account
 * can — see docs/THREAT_MODEL.md.
 */
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { NODE_OUTPUT_CAP } from "@spriessen/contracts";

export interface ScriptResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface RunOptions {
  readonly script: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  /** The shell; default `/bin/bash`. */
  readonly bashPath?: string;
  /** Text scrubbed from both streams (the pairing token). */
  readonly secret?: string;
  /** How long to wait for buffered output after bash exits; default 200 ms. */
  readonly drainMs?: number;
}

export interface RunningScript {
  readonly result: Promise<ScriptResult>;
  /** Kill the script's whole process group (cancel, agent stop). */
  readonly kill: () => void;
}

/** Env keys the agent reads for itself; a script never sees them. */
const AGENT_KEYS = /^SPRIESSEN_NODE_|^ULTIV_NODE_/;

export const scriptEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(env).filter(([key]) => !AGENT_KEYS.test(key)));

export const scrub = (text: string, secret: string | undefined): string =>
  secret === undefined || secret.length < 8 ? text : text.split(secret).join("[redacted]");

/** Collects one stream up to the cap, decoding UTF-8 across chunk borders. */
const collector = () => {
  const decoder = new StringDecoder("utf8");
  let text = "";
  return {
    push: (chunk: Buffer) => {
      if (text.length < NODE_OUTPUT_CAP) text += decoder.write(chunk);
    },
    done: () => (text.length < NODE_OUTPUT_CAP ? text + decoder.end() : text),
  };
};

export const runScript = (options: RunOptions): RunningScript => {
  const child = spawn(options.bashPath ?? "/bin/bash", ["-c", options.script], {
    cwd: options.cwd,
    env: scriptEnv(process.env),
    detached: true, // its own process group: the kill below reaches every descendant
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = collector();
  const stderr = collector();
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  let killedBy: "timeout" | "kill" | undefined;
  const killGroup = (): void => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // The group is already gone.
    }
  };
  const timer = setTimeout(() => {
    killedBy = "timeout";
    killGroup();
  }, options.timeoutMs);
  const result = new Promise<ScriptResult>((resolve, reject) => {
    let settled = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let err = stderr.done();
      if (killedBy === "timeout") err += `\n[bash] killed after ${options.timeoutMs}ms`;
      else if (signal !== null) err += `\n[bash] killed by ${signal}`;
      resolve({
        stdout: scrub(stdout.done(), options.secret).slice(0, NODE_OUTPUT_CAP),
        stderr: scrub(err, options.secret).slice(0, NODE_OUTPUT_CAP),
        exitCode: killedBy === "timeout" ? 124 : (code ?? (signal !== null ? 137 : 1)),
      });
    };
    child.on("error", (cause) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(cause);
    });
    // close = bash exited AND its pipes closed (the usual case, no drain wait).
    child.on("close", finish);
    // exit = bash itself is done; a background job may still hold the pipes.
    child.on("exit", (code, signal) => {
      setTimeout(() => finish(code, signal), options.drainMs ?? 200);
    });
  });
  return {
    result,
    kill: () => {
      killedBy ??= "kill";
      killGroup();
    },
  };
};
