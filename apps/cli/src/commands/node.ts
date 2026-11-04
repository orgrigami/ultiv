/**
 * `spriessen node …`: this machine as a paired node (the bash tool's `node`
 * target), and the owner's node registry from the terminal.
 *
 *   spriessen node                       run the agent (token from the config folder)
 *   spriessen node pair --name <n> --root <dir> [--root <dir>…]
 *                                        pair THIS machine (signed in); the token is
 *                                        saved 0600 and never printed
 *   spriessen node list | revoke <name> | roots <name> --root <dir>…
 *
 * The agent is the same code as apps/agent (`connectAgent`): it dials OUT,
 * sends the token as a Bearer header, starts each script inside the roots
 * and kills a script's whole process group on timeout or cancel.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { connectAgent, resolveToken } from "@spriessen/agent";
import type { NodeInfo } from "@spriessen/contracts";
import { allFlags, boolFlag, stringFlag, type Parsed } from "../args.ts";
import type { Api } from "../client/http.ts";
import { nodeTokenPath, saveNodeToken, serverOf } from "../config.ts";
import { apiFor } from "./context.ts";

const findNode = async (api: Api, wanted: string | undefined): Promise<NodeInfo> => {
  if (wanted === undefined) throw new Error("name the node (see: spriessen node list)");
  const nodes = (await api.nodes()).filter((node) => node.status === "paired");
  const found = nodes.find((node) => node.id === wanted || node.name === wanted);
  if (found === undefined) throw new Error(`no paired node named ${wanted}`);
  return found;
};

const rootsOf = (argv: readonly string[]): string[] => {
  const roots = allFlags(argv, "root").map((root) => resolve(root));
  if (roots.length === 0)
    throw new Error("give at least one --root <dir> the node may start scripts in");
  return roots;
};

const runAgent = async (parsed: Parsed): Promise<void> => {
  const server = serverOf(stringFlag(parsed, "server"));
  const fallbackFile = existsSync(nodeTokenPath()) ? nodeTokenPath() : undefined;
  const token = resolveToken({
    token: stringFlag(parsed, "token"),
    tokenFile: stringFlag(parsed, "token-file") ?? fallbackFile,
  });
  if (token === undefined) {
    throw new Error(
      "this machine is not paired yet: run `spriessen node pair --name <name> --root <dir>`",
    );
  }
  if (token.warning !== undefined) console.error(token.warning);
  const agent = connectAgent({
    url: server,
    token: token.token,
    log: (line) => console.error(line),
    onReady: (node) =>
      console.error(`node: ${node.name} serving ${node.roots.join(", ")} for ${server}`),
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => agent.stop());
  // Done on ctrl-c, or when the server refuses the token (revoked): then
  // pairing again is the only way back, and the agent has said so.
  await agent.done;
};

const pair = async (parsed: Parsed, argv: readonly string[]): Promise<void> => {
  const name = stringFlag(parsed, "name");
  if (name === undefined) throw new Error("usage: spriessen node pair --name <name> --root <dir>");
  if (existsSync(nodeTokenPath()) && !boolFlag(parsed, "force")) {
    throw new Error(
      `this machine already has a node token (${nodeTokenPath()}); --force replaces it`,
    );
  }
  const api = apiFor(parsed);
  const paired = await api.pairNode(name, rootsOf(argv));
  const path = saveNodeToken(paired.token);
  console.log(
    `Paired ${paired.node.name} (${paired.node.roots.join(", ")}). Token saved to ${path}.`,
  );
  console.log("Run it now: spriessen node    or keep it running: spriessen daemon install node");
};

const list = async (parsed: Parsed): Promise<void> => {
  const nodes = await apiFor(parsed).nodes();
  if (boolFlag(parsed, "json")) return console.log(JSON.stringify(nodes, null, 2));
  if (nodes.length === 0) return console.log("No nodes paired.");
  for (const node of nodes) {
    const state =
      node.status === "revoked" ? "revoked" : node.connected ? "connected" : "disconnected";
    console.log(`${node.name.padEnd(20)} ${state.padEnd(13)} ${node.roots.join(", ")}`);
  }
};

export const nodeCommand = async (parsed: Parsed, argv: readonly string[]): Promise<void> => {
  const sub = parsed.positionals[1];
  if (sub === undefined || sub === "run") return runAgent(parsed);
  if (sub === "pair") return pair(parsed, argv);
  if (sub === "list") return list(parsed);
  const api = apiFor(parsed);
  if (sub === "revoke") {
    const node = await findNode(api, parsed.positionals[2]);
    await api.revokeNode(node.id);
    return console.log(`Revoked ${node.name}; its agent is disconnected and its token is dead.`);
  }
  if (sub === "roots") {
    const node = await findNode(api, parsed.positionals[2]);
    const updated = await api.setNodeRoots(node.id, rootsOf(argv));
    return console.log(`${updated.name} now starts scripts in ${updated.roots.join(", ")}.`);
  }
  throw new Error(`unknown: spriessen node ${sub} (run, pair, list, revoke, roots)`);
};
