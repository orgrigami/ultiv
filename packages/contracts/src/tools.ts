import { arr, obj, str, type Static } from "@earendil-works/pi-schema";

/** One tool of the installed catalog: its name and what it is for, one line. */
export const ToolCatalogEntrySchema = obj(
  {
    name: str(),
    description: str(),
  },
  { open: true },
);

export type ToolCatalogEntry = Static<typeof ToolCatalogEntrySchema>;

/**
 * The tool catalog (`GET /api/tools`): everything a bot's allowlist may
 * curate. Plain-REST payload shape — the allowlist editor reads it; no
 * chord contract rides on it.
 */
export const ToolCatalogSchema = arr(ToolCatalogEntrySchema);

export type ToolCatalog = Static<typeof ToolCatalogSchema>;
