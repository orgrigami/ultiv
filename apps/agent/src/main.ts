/**
 * The node agent's standalone entry: the long-lived process the owner runs
 * on their other machine (the `spriessen node` command runs the same
 * `connectAgent`). Dials OUT to the server's `/agent` endpoint with the
 * node's pairing token and runs bash execs that start inside the node's
 * registered roots. Never accepts inbound connections, never logs the token.
 *
 * Usage:
 *   vp node apps/agent/src/main.ts --url http://server:8787 --token-file ~/.spriessen-node
 * Env: SPRIESSEN_SERVER_URL, SPRIESSEN_NODE_TOKEN_FILE, SPRIESSEN_NODE_TOKEN (flags win).
 */
import { nodeVersionProblem } from "@spriessen/core";
import { connectAgent } from "./agent.ts";
import { resolveToken } from "./token.ts";

const flagOf = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const numberFlag = (name: string): number | undefined => {
  const value = flagOf(name);
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

const usage = (): string =>
  "usage: vp node apps/agent/src/main.ts --url <server-origin> --token-file <path>\n" +
  "  env: SPRIESSEN_SERVER_URL, SPRIESSEN_NODE_TOKEN_FILE (or SPRIESSEN_NODE_TOKEN)";

const nodeProblem = nodeVersionProblem();
if (nodeProblem !== undefined) {
  console.error(`agent: ${nodeProblem.text}`);
  if (nodeProblem.fatal) process.exit(1);
}

const url = flagOf("url") ?? process.env["SPRIESSEN_SERVER_URL"];
let resolved: ReturnType<typeof resolveToken>;
try {
  resolved = resolveToken({ token: flagOf("token"), tokenFile: flagOf("token-file") });
} catch (cause) {
  console.error(`agent: ${cause instanceof Error ? cause.message : String(cause)}`);
  process.exit(1);
}
if (url === undefined || url === "" || resolved === undefined) {
  console.error(usage());
  process.exit(1);
}
if (resolved.warning !== undefined) console.error(resolved.warning);

const heartbeatMs = numberFlag("heartbeat-ms");
const backoffMs = numberFlag("backoff-ms");
const agent = connectAgent({
  url,
  token: resolved.token,
  ...(heartbeatMs !== undefined ? { heartbeatMs } : {}),
  ...(backoffMs !== undefined ? { backoffMs } : {}),
  log: (line) => console.error(line),
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    agent.stop();
    void agent.done.then(() => process.exit(0));
  });
}
