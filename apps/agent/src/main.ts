/**
 * The node agent CLI: the long-lived process the owner runs on their other
 * machine. Dials OUT to the server's `/agent` endpoint with the node's
 * pairing token and runs bash execs confined to the node's registered roots.
 * Never accepts inbound connections, never logs the token.
 *
 * Usage:
 *   node src/main.ts --url http://server:8787 --token <pairing-token>
 * Env: SPRIESSEN_SERVER_URL, SPRIESSEN_NODE_TOKEN (flags win).
 */
import { connectAgent } from "./agent.ts";

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
  "usage: node src/main.ts --url <server-origin> --token <pairing-token>\n" +
  "  env: SPRIESSEN_SERVER_URL, SPRIESSEN_NODE_TOKEN";

const url = flagOf("url") ?? process.env["SPRIESSEN_SERVER_URL"];
const token = flagOf("token") ?? process.env["SPRIESSEN_NODE_TOKEN"];
if (url === undefined || url === "" || token === undefined || token === "") {
  console.error(usage());
  process.exit(1);
}

const heartbeatMs = numberFlag("heartbeat-ms");
const backoffMs = numberFlag("backoff-ms");
const agent = connectAgent({
  url,
  token,
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
