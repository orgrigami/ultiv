/**
 * Enforcement: a route handler may not decide access itself. The detector
 * scans the REST sources for owner-label comparisons against the caller
 * (the shape every historical hole took) outside the two files that are
 * ALLOWED to compare labels (can.ts, owner-scope.ts). The planted bad
 * example proves the detector fires; the real sources prove it passes.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

const here = dirname(fileURLToPath(import.meta.url));
/** The only files that may compare owner labels: the decision itself. */
const ALLOWED = new Set(["can.ts", "owner-scope.ts", "types.ts"]);

/** Owner-label comparisons against the caller, in any spelling. */
const INLINE_ACCESS = [
  /args\.owner\s*[!=]==?/,
  /[!=]==?\s*args\.owner\b/,
  /\bowner\s*[!=]==?\s*["'`]guest["'`]/,
];

export const scanSource = (source: string): string[] => {
  const hits: string[] = [];
  for (const [index, line] of source.split("\n").entries()) {
    if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue;
    if (INLINE_ACCESS.some((pattern) => pattern.test(line))) {
      hits.push(`line ${index + 1}: ${line.trim()}`);
    }
  }
  return hits;
};

const restSources = (): { readonly file: string; readonly source: string }[] => {
  const files = ["../rest.ts", ...readdirSync(here).filter((name) => name.endsWith(".ts"))];
  return files
    .map((file) => ({ file: file.split("/").pop() ?? file, path: join(here, file) }))
    .filter(({ file }) => !file.endsWith(".test.ts") && !ALLOWED.has(file))
    .map(({ file, path }) => ({ file, source: readFileSync(path, "utf8") }));
};

describe("access-decision enforcement", () => {
  it("flags the planted bad example (a route that compares labels itself)", () => {
    const bad = `
  if (path === "/api/legacy" && method === "GET") {
    const row = rows.find((candidate) => candidate.id === id);
    if (row.owner === args.owner) return json(200, row);
    if (args.owner !== "guest") return json(403, { error: "not yours" });
    return json(200, everything);
  }
`;
    expect(scanSource(bad).length).toBeGreaterThanOrEqual(2);
  });

  it("passes on the real REST sources: every decision is can()'s", () => {
    const offenders = restSources().flatMap(({ file, source }) =>
      scanSource(source).map((hit) => `${file} ${hit}`),
    );
    expect(offenders).toEqual([]);
  });
});
