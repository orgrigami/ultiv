/**
 * The node registry: the owner's other machines, paired as bash `node`
 * targets. One durable doc family (`ultiv.nodes`); pairing is an OWNER act —
 * the mind NEVER sees a pairing token. Like webhook bearer tokens, a token
 * exists only as its SHA-256 (`tokenHash`) and appears exactly once, in the
 * minting response the pair dialog shows; revocation flips the stored status
 * (and kills the live connection when the transport is wired), after which
 * the token verifies false mid-connection. `resolveNodeId` is the one lookup
 * the bash gate and the bash tool share: a call resolves its node by NAME,
 * or the owner's single paired node when it names none — zero or ambiguous
 * pairing answers undefined, and the caller turns that into a structured,
 * owner-actionable error. Nothing here ever logs a token or its hash.
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { defineDoc } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import type { NodeInfo, NodePairResponse } from "@spriessen/contracts";
import type { ConverseService } from "../converse/converse.ts";

/** The stored row: the public info plus the pairing token's hash. */
export type StoredNode = NodeInfo & { tokenHash: string };

/** `sha256:<hex>` of a pairing token — the only form a token is stored in. */
export const hashNodeToken = (token: string): string =>
  `sha256:${createHash("sha256").update(token, "utf8").digest("hex")}`;

/** Constant-time compare of two token hashes (equal-length hex by construction). */
const hashesMatch = (stored: string, presented: string): boolean => {
  const a = Buffer.from(stored, "utf8");
  const b = Buffer.from(presented, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
};

/** The public view of a row: no hash. */
const publicOf = (row: StoredNode): NodeInfo => {
  const { tokenHash: _hash, ...info } = row;
  return info;
};

export const NodesDoc = defineDoc<{ items: StoredNode[] }>({
  kind: "ultiv.nodes",
  version: 1,
  scope: "session",
  initial: () => ({ items: [] }),
  checkpointWhen: () => true,
});

const readStored = async (converse: ConverseService): Promise<StoredNode[]> =>
  (await Effect.runPromise(converse.docs.snapshot(NodesDoc)))?.items ?? [];

/** Throwaway tokens are fine to mint; 32 bytes is the webhook discipline. */
const mintToken = (): string => randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");

/** A root must be an absolute POSIX path (the agent runs where the repos live). */
export const nodeRootProblem = (roots: readonly string[]): string | undefined => {
  if (roots.length === 0) return "at least one allowed root is required";
  if (roots.length > 20) return "at most 20 roots per node";
  const bad = roots.find((root) => !root.startsWith("/") || root.trim() !== root);
  if (bad !== undefined) return `roots must be absolute paths (bad: ${bad.slice(0, 80)})`;
  return undefined;
};

/** Pair a node for one owner: mints the one-time token, stores only its hash. */
export const pairNode = async (
  converse: ConverseService,
  owner: string,
  input: { name?: string; roots?: readonly string[] },
): Promise<NodePairResponse> => {
  const name = input.name?.trim() ?? "";
  if (name === "" || name.length > 80) throw new Error("name the node (1-80 characters)");
  const roots = [...(input.roots ?? [])];
  const problem = nodeRootProblem(roots);
  if (problem !== undefined) throw new Error(problem);
  const mine = (await readStored(converse)).filter(
    (row) => row.owner === owner && row.status === "paired",
  );
  if (mine.some((row) => row.name === name))
    throw new Error(`a paired node named ${name} already exists`);
  const token = mintToken();
  const row: StoredNode = {
    id: `node-${randomUUID().slice(0, 8)}`,
    owner,
    name,
    roots,
    status: "paired",
    connected: false,
    lastSeenAt: null,
    createdAt: Date.now(),
    tokenHash: hashNodeToken(token),
  };
  await Effect.runPromise(
    converse.docs.commit(async (tx) => {
      const draft = await tx.doc(NodesDoc);
      draft.items = [...draft.items, row];
    }),
  );
  return { node: publicOf(row), token };
};

/** Every node, public view (never a token or its hash). */
export const listNodes = async (converse: ConverseService): Promise<NodeInfo[]> =>
  (await readStored(converse)).map(publicOf);

/** One node's public view by id, or undefined. */
export const nodeOf = async (
  converse: ConverseService,
  id: string,
): Promise<NodeInfo | undefined> => {
  const row = (await readStored(converse)).find((candidate) => candidate.id === id);
  return row === undefined ? undefined : publicOf(row);
};

/** Revoked nodes never dial in, and a live dial is dropped when the transport sees it. */
export const revokeNode = async (converse: ConverseService, id: string): Promise<boolean> => {
  const row = (await readStored(converse)).find((candidate) => candidate.id === id);
  if (row === undefined) return false;
  await Effect.runPromise(
    converse.docs.commit(async (tx) => {
      const draft = await tx.doc(NodesDoc);
      draft.items = draft.items.map((candidate) =>
        candidate.id === id ? { ...candidate, status: "revoked", connected: false } : candidate,
      );
    }),
  );
  return true;
};

/** Replace a node's allowed roots (absolute paths, nodeRootProblem-checked). */
export const updateNodeRoots = async (
  converse: ConverseService,
  id: string,
  roots: readonly string[],
): Promise<NodeInfo | undefined> => {
  const problem = nodeRootProblem(roots);
  if (problem !== undefined) throw new Error(problem);
  const row = (await readStored(converse)).find((candidate) => candidate.id === id);
  if (row === undefined) return undefined;
  await Effect.runPromise(
    converse.docs.commit(async (tx) => {
      const draft = await tx.doc(NodesDoc);
      draft.items = draft.items.map((candidate) =>
        candidate.id === id ? { ...candidate, roots: [...roots] } : candidate,
      );
    }),
  );
  return nodeOf(converse, id);
};

/** Does `presented` open node `id`? Hash compare, paired rows only. */
export const verifyNodeToken = async (
  converse: ConverseService,
  id: string,
  presented: string,
): Promise<boolean> => {
  const row = (await readStored(converse)).find((candidate) => candidate.id === id);
  return (
    row !== undefined &&
    row.status === "paired" &&
    hashesMatch(row.tokenHash, hashNodeToken(presented))
  );
};

/**
 * Resolve a node call's target: the paired node NAME the call gives, or the
 * owner's single paired node. Undefined means "not resolvable" — zero or
 * ambiguous pairing, an unknown name, or (failing safe) a revoked row.
 */
export const resolveNodeId = async (
  converse: ConverseService,
  owner: string,
  name: string | null,
): Promise<string | undefined> => {
  const paired = (await readStored(converse)).filter(
    (row) => row.owner === owner && row.status === "paired",
  );
  if (name === null) return paired.length === 1 ? paired[0]?.id : undefined;
  return paired.find((row) => row.name === name)?.id;
};

// -- transport bookkeeping (the /agent endpoint and the exec path call these) --

export const markNodeSeen = async (converse: ConverseService, id: string): Promise<void> => {
  await Effect.runPromise(
    converse.docs.commit(async (tx) => {
      const draft = await tx.doc(NodesDoc);
      draft.items = draft.items.map((candidate) =>
        candidate.id === id ? { ...candidate, connected: true, lastSeenAt: Date.now() } : candidate,
      );
    }),
  );
};

export const markNodeDisconnected = async (
  converse: ConverseService,
  id: string,
): Promise<void> => {
  await Effect.runPromise(
    converse.docs.commit(async (tx) => {
      const draft = await tx.doc(NodesDoc);
      draft.items = draft.items.map((candidate) =>
        candidate.id === id ? { ...candidate, connected: false } : candidate,
      );
    }),
  );
};
