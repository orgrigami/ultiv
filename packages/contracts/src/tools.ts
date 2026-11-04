import { Type, type Static } from "typebox";

/** One tool of the installed catalog: its name and what it is for, one line. */
export const ToolCatalogEntrySchema = Type.Object({
  name: Type.String(),
  description: Type.String(),
});

export type ToolCatalogEntry = Static<typeof ToolCatalogEntrySchema>;

/**
 * The tool catalog (`GET /api/tools`): everything a bot's allowlist may
 * curate. Plain-REST payload shape — the allowlist editor reads it; no
 * chord contract rides on it.
 */
export const ToolCatalogSchema = Type.Array(ToolCatalogEntrySchema);

export type ToolCatalog = Static<typeof ToolCatalogSchema>;
