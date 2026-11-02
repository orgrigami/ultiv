/**
 * The node registry's REST shapes: the owner's other machines paired as bash
 * `node` targets. A row's pairing token exists only as a hash server-side;
 * the token itself appears exactly once — in the minting response.
 */
import { Type, type Static } from "typebox";

export const NodeInfoSchema = Type.Object({
  id: Type.String(),
  /** The owning account; nodes are owner-level, never per bot. */
  owner: Type.String(),
  name: Type.String(),
  /** Absolute paths the node's agent confines every exec to. */
  roots: Type.Array(Type.String()),
  status: Type.Union([Type.Literal("paired"), Type.Literal("revoked")]),
  /** Live transport state (the /agent endpoint's view); false while offline. */
  connected: Type.Boolean(),
  lastSeenAt: Type.Union([Type.Number(), Type.Null()]),
  createdAt: Type.Number(),
});
export type NodeInfo = Static<typeof NodeInfoSchema>;

export type NodeList = NodeInfo[];

/** The minting response: the ONLY place a pairing token ever appears. */
export const NodePairResponseSchema = Type.Object({
  node: NodeInfoSchema,
  token: Type.String(),
});
export type NodePairResponse = Static<typeof NodePairResponseSchema>;

// ---------------------------------------------------------------------------
// The /agent transport: the node agent dials OUT to the server's endpoint;
// the server never dials in. JSON text frames, one of these per message.

/** The bash tool's output cap: the agent's results never exceed it per stream. */
export const NODE_OUTPUT_CAP = 20_000;

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
      readonly type: "exec";
      readonly id: string;
      readonly script: string;
      /** Where to run; confined to the node's registered roots. */
      readonly cwd?: string;
      readonly timeoutMs: number;
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
