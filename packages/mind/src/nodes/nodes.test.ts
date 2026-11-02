/**
 * The node registry (mind layer): pairing mints a one-time token whose hash
 * is the only stored trace, resolveNodeId answers the bash gate's lookups,
 * and revocation makes the token verify false. Tokens never ride a list or
 * a log line.
 */
import { describe, expect, it } from "vite-plus/test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openMind } from "../entity.ts";
import {
  hashNodeToken,
  listNodes,
  nodeOf,
  pairNode,
  resolveNodeId,
  revokeNode,
  updateNodeRoots,
  verifyNodeToken,
} from "./nodes.ts";

describe("the node registry", () => {
  it("pairs, stores only the hash, and shows the token once", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const { converse } = handle.mind;
    const paired = await pairNode(converse, "owner-a", {
      name: "node-x",
      roots: ["/home/owner-a/repos"],
    });
    expect(paired.token).toMatch(/^[0-9a-f]{64}$/);
    expect(paired.node).toMatchObject({
      name: "node-x",
      roots: ["/home/owner-a/repos"],
      status: "paired",
      connected: false,
      lastSeenAt: null,
    });
    // The public views never carry the hash or the token.
    const listed = await listNodes(converse);
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(paired.token);
    expect(JSON.stringify(listed)).not.toContain("tokenHash");
    expect(await nodeOf(converse, paired.node.id)).toEqual(listed[0]);
    // Verification works against the minted token, only for paired rows.
    expect(await verifyNodeToken(converse, paired.node.id, paired.token)).toBe(true);
    expect(await verifyNodeToken(converse, paired.node.id, "nope")).toBe(false);
    await handle.close();
  });

  it("refuses bad input: empty name, relative roots, duplicate name", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const { converse } = handle.mind;
    await expect(pairNode(converse, "owner-a", { name: "", roots: ["/r"] })).rejects.toThrow(
      /name the node/,
    );
    await expect(
      pairNode(converse, "owner-a", { name: "node-x", roots: ["relative/path"] }),
    ).rejects.toThrow(/absolute paths/);
    await expect(pairNode(converse, "owner-a", { name: "node-x", roots: [] })).rejects.toThrow(
      /at least one allowed root/,
    );
    await pairNode(converse, "owner-a", { name: "node-x", roots: ["/r"] });
    await expect(pairNode(converse, "owner-a", { name: "node-x", roots: ["/s"] })).rejects.toThrow(
      /already exists/,
    );
    // The same name under another owner is fine.
    await pairNode(converse, "owner-b", { name: "node-x", roots: ["/s"] });
    await handle.close();
  });

  it("resolves by name or the single paired node; zero and ambiguous answer undefined", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const { converse } = handle.mind;
    // Zero pairing: undefined either way (fail safe, never a guess).
    expect(await resolveNodeId(converse, "owner-a", null)).toBeUndefined();
    expect(await resolveNodeId(converse, "owner-a", "node-x")).toBeUndefined();
    const only = await pairNode(converse, "owner-a", { name: "solo", roots: ["/r"] });
    expect(await resolveNodeId(converse, "owner-a", null)).toBe(only.node.id);
    expect(await resolveNodeId(converse, "owner-a", "solo")).toBe(only.node.id);
    expect(await resolveNodeId(converse, "owner-a", "other")).toBeUndefined();
    // A second paired node makes the unnamed resolution ambiguous.
    const second = await pairNode(converse, "owner-a", { name: "solo-2", roots: ["/s"] });
    expect(await resolveNodeId(converse, "owner-a", null)).toBeUndefined();
    expect(await resolveNodeId(converse, "owner-a", "solo")).toBe(only.node.id);
    expect(await resolveNodeId(converse, "owner-a", "solo-2")).toBe(second.node.id);
    // Another owner's nodes never resolve.
    expect(await resolveNodeId(converse, "owner-b", "solo")).toBeUndefined();
    await handle.close();
  });

  it("revocation kills the token mid-flight; root updates stay in the public view", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const { converse } = handle.mind;
    const paired = await pairNode(converse, "owner-a", { name: "node-x", roots: ["/r"] });
    expect(await revokeNode(converse, paired.node.id)).toBe(true);
    expect(await revokeNode(converse, "node-missing")).toBe(false);
    expect((await nodeOf(converse, paired.node.id))?.status).toBe("revoked");
    expect((await nodeOf(converse, paired.node.id))?.connected).toBe(false);
    // The token stops verifying at once — a revoked dial is refused.
    expect(await verifyNodeToken(converse, paired.node.id, paired.token)).toBe(false);
    // And a revoked node never resolves.
    expect(await resolveNodeId(converse, "owner-a", "node-x")).toBeUndefined();
    expect(await resolveNodeId(converse, "owner-a", null)).toBeUndefined();
    // Roots replace wholesale and are validated.
    expect(await updateNodeRoots(converse, paired.node.id, ["/a", "/b"])).toMatchObject({
      roots: ["/a", "/b"],
    });
    await expect(updateNodeRoots(converse, paired.node.id, ["nope"])).rejects.toThrow(
      /absolute paths/,
    );
    expect(await updateNodeRoots(converse, "node-missing", ["/a"])).toBeUndefined();
    await handle.close();
  });

  it("hashes are sha256-prefixed and never equal the token", async () => {
    expect(hashNodeToken("tok")).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(hashNodeToken("tok")).not.toContain("tok");
  });
});
