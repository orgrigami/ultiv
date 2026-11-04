import type { ToolCatalogEntry } from "@spriessen/contracts";

/**
 * Pure helpers behind the bot edit dialog's "Allowed tools" section. The
 * allowlist is a curated list of catalog tool names; null = every installed
 * tool (the field is PATCHed wholesale, never merged).
 */

/** Catalog rows matching the search box: the query hits the name or the description. */
export const allowlistMatches = (
  catalog: readonly ToolCatalogEntry[],
  query: string,
): readonly ToolCatalogEntry[] => {
  const q = query.trim().toLocaleLowerCase("en");
  if (q === "") return [...catalog];
  return catalog.filter(
    (tool) =>
      tool.name.toLocaleLowerCase("en").includes(q) ||
      tool.description.toLocaleLowerCase("en").includes(q),
  );
};

/**
 * How many installed tools a curated list omits — the silent-gap readout:
 * a new catalog tool never reaches an allowlisted bot until the owner adds
 * it, so the count keeps that gap visible.
 */
export const notOnList = (
  catalog: readonly ToolCatalogEntry[],
  list: readonly string[],
): number => {
  const curated = new Set(list);
  return catalog.filter((tool) => !curated.has(tool.name)).length;
};
