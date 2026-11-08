/**
 * The `table` tool: the profile's typed tables (tables.ts) as one tool with
 * an op, exactly like the checklist. Chat-safe by the KV plane's rule: it
 * touches only this bot's own tables; it is audited, never gated. Rows are
 * returned as readable lines (ids lead, like memory handles: update and
 * remove take them).
 */
import { arr, bool, num, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { defineTool, type Tool } from "@spriessen/ext";
import type { ProfilesService } from "../profiles/profiles.ts";
import type { TablesService, TableRowData } from "./tables.ts";

const fail = (text: string) => ({
  output: [{ type: "text" as const, text }],
  isError: true as const,
});

const rowLine = (row: {
  readonly id: string;
  readonly at: number;
  readonly data: TableRowData;
}): string =>
  `${row.id} ${new Date(row.at).toISOString().slice(0, 10)} ${JSON.stringify(row.data)}`;

export const tableTools = (tables: TablesService, profiles: ProfilesService): readonly Tool[] => {
  const tool: Tool = defineTool({
    name: "table",
    description:
      "Your own durable TABLES (they survive sessions and restarts): named tables with typed " +
      "columns, for ledgers, trackers and running lists that outgrow a state value. One tool, one " +
      "op per call: create a table (name + columns of string/number/boolean), list yours, read " +
      "rows, add or update a row (whole row each time), remove a row or a whole table. Rows cap at " +
      "1000 (oldest fall off first); at most 10 tables.",
    parameters: obj(
      {
        op: oneOf(["create", "list", "rows", "add", "update", "remove_row", "remove"], {
          description: "What to do; each call does one op.",
        }),
        name: opt(
          str({ description: 'The table name, e.g. "invoice-tracker" (create, rows, add…).' }),
        ),
        columns: opt(
          arr(
            obj(
              {
                name: str({ description: "Column name." }),
                type: oneOf(["string", "number", "boolean"], { description: "The column's type." }),
              },
              { open: true },
            ),
            { description: "create: the table's columns (1 to 12)." },
          ),
        ),
        row: opt(
          obj(
            {},
            {
              open: true,
              description: "add/update: the whole row, one field per column (null = empty).",
            },
          ),
        ),
        rowId: opt(str({ description: "update/remove_row: the row's id (rows list them first)." })),
        limit: opt(num({ description: "rows: how many, newest first (default 100)." })),
      },
      { open: true },
    ),
    structuredOutputSchema: obj(
      {
        op: str(),
        ok: bool(),
      },
      { open: true },
    ),
    execute: async (args, api) => {
      const scope = profiles.scopeOf(String(api.conversationId));
      if (scope === undefined) return fail("refused: this conversation belongs to no profile.");
      const owner = scope.owner;
      const profile = scope.profileId;
      const name = args.name?.trim() ?? "";
      try {
        if (args.op === "create") {
          if (name === "" || args.columns === undefined) {
            return fail("create takes name and columns (each {name, type}).");
          }
          const table = await tables.create({ owner, profile, name, columns: args.columns });
          return {
            output: [
              {
                type: "text" as const,
                text: `created table "${table.name}" (${table.columns.map((c) => `${c.name}:${c.type}`).join(", ")})`,
              },
            ],
            structuredOutput: { op: "create", ok: true, name: table.name },
          };
        }
        if (args.op === "list") {
          const mine = await tables.list(owner, profile);
          return {
            output: [
              {
                type: "text" as const,
                text:
                  mine.length === 0
                    ? "no tables yet; create one (op create, name + columns)."
                    : mine
                        .map(
                          (table) =>
                            `${table.name} (${table.rows.length} rows): ${table.columns.map((c) => `${c.name}:${c.type}`).join(", ")}`,
                        )
                        .join("\n"),
              },
            ],
            structuredOutput: { op: "list", ok: true, tables: mine.map((t) => t.name) },
          };
        }
        if (name === "") return fail(`op ${args.op} needs the table name.`);
        if (args.op === "rows") {
          const rows = await tables.rows(owner, profile, name, args.limit ?? 100);
          return {
            output: [
              {
                type: "text" as const,
                text: rows.length === 0 ? `"${name}" has no rows.` : rows.map(rowLine).join("\n"),
              },
            ],
            structuredOutput: { op: "rows", ok: true, count: rows.length },
          };
        }
        if (args.op === "add" || args.op === "update") {
          const data = (args.row ?? {}) as TableRowData;
          const row =
            args.op === "add"
              ? await tables.addRow(owner, profile, name, data)
              : await tables.setRow(owner, profile, name, args.rowId ?? "", data);
          return {
            output: [
              {
                type: "text" as const,
                text: `${args.op === "add" ? "added" : "updated"} ${rowLine(row)}`,
              },
            ],
            structuredOutput: { op: args.op, ok: true, id: row.id },
          };
        }
        if (args.op === "remove_row") {
          const removed = await tables.removeRow(owner, profile, name, args.rowId ?? "");
          return {
            output: [
              {
                type: "text" as const,
                text: removed ? `removed row ${args.rowId}` : `no row ${args.rowId}`,
              },
            ],
            structuredOutput: { op: "remove_row", ok: true, removed },
          };
        }
        const removed = await tables.remove(owner, profile, name);
        return {
          output: [
            {
              type: "text" as const,
              text: removed ? `removed table "${name}"` : `no table "${name}"`,
            },
          ],
          structuredOutput: { op: "remove", ok: true, removed },
        };
      } catch (cause) {
        return fail((cause as { reason?: string }).reason ?? String(cause));
      }
    },
  });
  return [tool];
};
