/**
 * Crew › bot › Tables: the bot's typed tables (the `table` tool's store) as
 * compact grids — newest row first, columns from the table's definition,
 * numbers right-aligned. Read-only to the owner (bots write through the
 * tool); a table can be removed here.
 */
import { useCallback, useEffect, useState } from "react";
import { Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { SectionHeader } from "@/components/ui/section-header";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";
import type { ProfileInfo } from "@spriessen/contracts";

interface TableView {
  id: string;
  name: string;
  columns: { name: string; type: string }[];
  rows: { id: string; at: number; data: Record<string, string | number | boolean | null> }[];
  updatedAt: number;
}

export function TablesTab({ bot }: { bot: ProfileInfo }) {
  const [tables, setTables] = useState<TableView[] | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const reload = useCallback(async (): Promise<void> => {
    try {
      setTables((await api.botTables(bot.id)).tables);
      setError(false);
    } catch {
      setError(true);
    }
  }, [bot.id]);
  useEffect(() => void reload(), [reload]);
  const remove = async (table: TableView): Promise<void> => {
    setBusy(table.id);
    try {
      await api.removeBotTable(bot.id, table.id);
      await reload();
    } finally {
      setBusy(null);
    }
  };
  return (
    <section aria-label="Tables" className="flex flex-col gap-3">
      <SectionHeader title="Tables" />
      {error && tables === null ? (
        <ErrorState message="Couldn't load the tables." onRetry={() => void reload()} />
      ) : tables === null ? (
        <SkeletonRows label="Loading tables" rows={2} />
      ) : tables.length === 0 ? (
        <EmptyState className="py-8">
          No tables yet. This bot keeps ledgers and trackers here when its work calls for them.
        </EmptyState>
      ) : (
        tables.map((table) => (
          <div key={table.id} className="bg-card flex flex-col rounded-xl border">
            <div className="flex items-center gap-3 px-3 py-2.5">
              <span className="min-w-0 flex-1 truncate font-mono text-sm">{table.name}</span>
              <span className="text-muted-foreground text-xs">{table.rows.length} rows</span>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy !== null}
                aria-label={`Remove table ${table.name}`}
                onClick={() => void remove(table)}
              >
                {busy === table.id ? <Spinner /> : <Trash2Icon />}
                Remove
              </Button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-muted-foreground border-border border-t">
                  <tr>
                    {table.columns.map((column) => (
                      <th key={column.name} className="px-3 py-2 font-normal" scope="col">
                        {column.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="font-mono divide-border divide-y">
                  {table.rows.map((row) => (
                    <tr key={row.id}>
                      {table.columns.map((column) => {
                        const value = row.data[column.name] ?? "";
                        return (
                          <td
                            key={column.name}
                            className={
                              typeof value === "number"
                                ? "px-3 py-1.5 text-right tabular-nums"
                                : "px-3 py-1.5"
                            }
                          >
                            {String(value)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}
      <p className="text-muted-foreground text-xs">
        Tables belong to this bot: it writes them with its table tool (ledgers, trackers, running
        lists) and they survive restarts. Removing one here cannot be undone.
      </p>
    </section>
  );
}
