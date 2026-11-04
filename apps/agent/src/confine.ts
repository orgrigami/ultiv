/**
 * Where a script may START: inside one of the node's registered roots
 * (`resolveInside`: no `../`, no symlink out), the first root by default.
 * Roots are not a jail — the script runs as the owner's account and can `cd`
 * anywhere that account can (docs/THREAT_MODEL.md).
 */
import { resolveInside } from "@spriessen/core";

export const confine = (roots: readonly string[], cwd: string | undefined): string => {
  const want = cwd ?? roots[0];
  if (want === undefined) throw new Error("the agent has no registered roots");
  for (const root of roots) {
    try {
      return resolveInside(root, want);
    } catch {
      // try the next root
    }
  }
  throw new Error(
    `cwd "${want.slice(0, 200)}" is outside this node's registered roots ` +
      `(${roots.map((root) => root.slice(0, 120)).join(", ")})`,
  );
};
