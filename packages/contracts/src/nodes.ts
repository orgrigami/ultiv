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
