/**
 * The bash tool's `node` facade: the mind's node registry seen through ext's
 * narrow `NodeShellTransport` seam (ext never imports mind). Resolution is
 * the ONE lookup the gate and the tool share (`resolveNodeId`): the call's
 * node NAME, or the owner's single paired node — zero, ambiguous, unknown or
 * revoked answers undefined and the tool turns that into its structured,
 * owner-actionable error. The converse reference is late-bound: the registry
 * (and with it the bash plugin) builds before the converse layer, so the
 * facade reads `converseRef.current` per call, never at boot.
 */
import type { NodeShellTransport } from "@spriessen/ext";
import type { ConverseService } from "../converse/converse.ts";
import { nodeOf, resolveNodeId } from "./nodes.ts";

export const nodeShellFacadeOf = (
  converseRef: { current?: ConverseService },
  exec: (
    nodeId: string,
    request: { readonly script: string; readonly cwd?: string; readonly timeoutMs: number },
  ) => Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }>,
): NodeShellTransport => ({
  resolve: async (owner, name) => {
    const converse = converseRef.current;
    if (converse === undefined) return undefined;
    const id = await resolveNodeId(converse, owner, name);
    if (id === undefined) return undefined;
    const info = await nodeOf(converse, id);
    return info === undefined ? undefined : { id: info.id, name: info.name, roots: info.roots };
  },
  exec,
});
