/**
 * Node routes: owner-level pairing registry for bash's `node` target. The
 * pair response is the ONLY place a token ever appears — list/read answers
 * never carry it or its hash, and nothing here logs either. Another owner's
 * node reads exactly like a missing one (404 / filtered out), so ids cannot
 * be probed across accounts. Reads answer `connected` from the live dial;
 * a roots change reaches a connected agent at once.
 */
import { listNodes, nodeOf, pairNode, revokeNode, updateNodeRoots } from "@spriessen/mind";
import { findOwnedNode, nodesOwned } from "./owner-scope.ts";
import type { RouteArgs } from "./types.ts";

export async function nodeRoutes(
  args: RouteArgs,
  segment: (after: string) => string,
): Promise<boolean> {
  const { req, mind, path, json, owner } = args;
  const method = req.method ?? "GET";
  if (path === "/api/nodes" && method === "GET") {
    const mine = await nodesOwned(args, await listNodes(mind.converse));
    // `connected` is the live dial, never a stored flag a crash left behind.
    json(
      200,
      mine.map((node) => ({ ...node, connected: args.nodes?.connected(node.id) ?? false })),
    );
    return true;
  }
  if (path === "/api/nodes" && method === "POST") {
    const body = await args.readJson<{ name?: string; roots?: string[] }>(req);
    try {
      json(200, await pairNode(mind.converse, owner, body));
    } catch (cause) {
      json(400, { error: String(cause).slice(0, 300) });
    }
    return true;
  }
  if (path.startsWith("/api/nodes/") && path.endsWith("/revoke") && method === "POST") {
    const id = segment("/api/nodes/").slice(0, -"/revoke".length);
    const mine = await findOwnedNode(args, await nodeOf(mind.converse, id));
    const ok = mine !== undefined && (await revokeNode(mind.converse, id));
    // A successful revoke kills the live dial at once (the transport drops
    // its pending execs with a structured refusal).
    if (ok) args.nodes?.drop(id);
    json(200, { ok });
    return true;
  }
  if (path.startsWith("/api/nodes/") && path.endsWith("/roots") && method === "PUT") {
    const id = segment("/api/nodes/").slice(0, -"/roots".length);
    const mine = await findOwnedNode(args, await nodeOf(mind.converse, id));
    if (mine === undefined) {
      json(404, { error: "unknown node" });
      return true;
    }
    const body = await args.readJson<{ roots?: string[] }>(req);
    try {
      const updated = await updateNodeRoots(mind.converse, id, body.roots ?? []);
      // The live agent switches at once: narrowing roots never waits for a redial.
      if (updated !== undefined) args.nodes?.pushRoots(id, updated.roots);
      json(200, updated);
    } catch (cause) {
      json(400, { error: String(cause).slice(0, 300) });
    }
    return true;
  }
  return false;
}
