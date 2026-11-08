/**
 * Table routes: the owner's read on a bot's typed tables (tables/tables.ts).
 * GET /api/tables?profile=<id> lists them with their rows (newest first);
 * DELETE /api/tables/:id?profile=<id> removes one. Another owner's bot
 * answers 404 like a missing one. Bots write through the `table` tool; the
 * owner reads and removes here.
 */
import { type RouteArgs } from "./types.ts";

export interface TableView {
  readonly id: string;
  readonly name: string;
  readonly columns: { readonly name: string; readonly type: string }[];
  readonly rows: readonly {
    readonly id: string;
    readonly at: number;
    readonly data: Record<string, string | number | boolean | null>;
  }[];
  readonly updatedAt: number;
}

export async function tableRoutes(args: RouteArgs): Promise<boolean> {
  const { req, mind, path, json } = args;
  const method = req.method ?? "GET";
  if (path !== "/api/tables" && path.match(/^\/api\/tables\/[^/]+$/) === null) return false;
  const profileId = new URL(req.url ?? "", "http://local").searchParams.get("profile");
  if (profileId === null || profileId === "") {
    json(400, { error: "name a bot: /api/tables?profile=<id>" });
    return true;
  }
  const profile = await mind.profiles.get(args.owner, profileId);
  if (profile === undefined) {
    json(404, { error: "unknown bot" });
    return true;
  }
  const remove = path.match(/^\/api\/tables\/([^/]+)$/);
  if (remove !== null && method === "DELETE") {
    const tables = await mind.tables.list(args.owner, profileId);
    const table = tables.find((row) => row.id === remove[1]);
    if (table === undefined) {
      json(404, { error: "unknown table" });
      return true;
    }
    await mind.tables.remove(args.owner, profileId, table.name);
    json(200, { ok: true });
    return true;
  }
  if (path !== "/api/tables" || method !== "GET") return false;
  const tables = await mind.tables.list(args.owner, profileId);
  const views: TableView[] = tables.map((table) => ({
    id: table.id,
    name: table.name,
    columns: table.columns.map((column) => ({ name: column.name, type: column.type })),
    rows: table.rows.toReversed(),
    updatedAt: table.updatedAt,
  }));
  json(200, { tables: views });
  return true;
}
