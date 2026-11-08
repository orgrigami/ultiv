/**
 * The node registry's REST shapes: the owner's other machines paired as bash
 * `node` targets. A row's pairing token exists only as a hash server-side;
 * the token itself appears exactly once — in the minting response.
 */
import {
  arr,
  bool,
  nul,
  num,
  obj,
  oneOf,
  str,
  union,
  type Static,
} from "@earendil-works/pi-schema";

export const NodeInfoSchema = obj(
  {
    id: str(),
    /** The owning account; nodes are owner-level, never per bot. */
    owner: str(),
    name: str(),
    /** Absolute paths the node's agent confines every exec to. */
    roots: arr(str()),
    status: oneOf(["paired", "revoked"]),
    /** Live transport state (the /agent endpoint's view); false while offline. */
    connected: bool(),
    lastSeenAt: union([num(), nul()]),
    createdAt: num(),
  },
  { open: true },
);
export type NodeInfo = Static<typeof NodeInfoSchema>;

export type NodeList = NodeInfo[];

/** The minting response: the ONLY place a pairing token ever appears. */
export const NodePairResponseSchema = obj(
  {
    node: NodeInfoSchema,
    token: str(),
  },
  { open: true },
);
export type NodePairResponse = Static<typeof NodePairResponseSchema>;

// ---------------------------------------------------------------------------
// The /agent transport: the node agent dials OUT to the server's endpoint;
// the server never dials in. JSON text frames, one of these per message.

/** The bash tool's output cap: the agent's results never exceed it per stream. */
export const NODE_OUTPUT_CAP = 20_000;

/**
 * How much longer the server waits than the agent's own timeout: the agent
 * kills the script at `timeoutMs` and answers with its partial output (exit
 * 124); the server only gives up when even that answer never comes.
 */
export const NODE_EXEC_GRACE_MS = 5_000;

/** The largest frame either side accepts (two capped streams + JSON overhead). */
export const NODE_MAX_FRAME_BYTES = 1024 * 1024;

/** Server → agent. */
export type NodeAgentOutbound =
  | { readonly type: "pong" }
  | {
      /** Sent once after a dial authenticates: the node's identity + roots. */
      readonly type: "ready";
      readonly node: {
        readonly id: string;
        readonly name: string;
        readonly roots: readonly string[];
      };
    }
  | {
      /** The owner changed the node's roots: replaces the agent's copy at once. */
      readonly type: "roots";
      readonly roots: readonly string[];
    }
  | {
      readonly type: "exec";
      readonly id: string;
      readonly script: string;
      /** Where to START; must lie inside one of the node's registered roots. */
      readonly cwd?: string;
      readonly timeoutMs: number;
    }
  | {
      /** The turn that asked for exec `id` stopped: kill the script, send nothing back. */
      readonly type: "cancel";
      readonly id: string;
    };

/** Agent → server (after the server's `ready`). */
export type NodeAgentInbound =
  | { readonly type: "ping" }
  | {
      readonly type: "result";
      readonly id: string;
      readonly stdout: string;
      readonly stderr: string;
      readonly exitCode: number;
    }
  | { readonly type: "error"; readonly id: string; readonly message: string };
