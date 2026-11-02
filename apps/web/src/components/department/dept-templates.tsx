/**
 * Templates: what this department publishes (a bot, or a bot's
 * Instructions) and the bot templates other departments publish, copied
 * here as a fresh bot (no memory, chats or vault items ride along).
 */
import { useCallback, useEffect, useState } from "react";
import type { TemplateInfo } from "@spriessen/contracts";
import { Button } from "@/components/ui/button";
import { ListCard } from "@/components/ui/list-card";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { Select } from "@/components/ui/select";
import { useApp } from "@/lib/app-state";
import { orgApi } from "@/lib/org-api";
import { loadOrg, useOrg } from "@/lib/use-org";

const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const row = "flex min-h-11 items-center gap-2 px-3 py-2";

export function DeptTemplates({ departmentId }: { departmentId: string }) {
  const { sessions, refreshAll } = useApp();
  const { view } = useOrg();
  const [mine, setMine] = useState<TemplateInfo[]>([]);
  const [theirs, setTheirs] = useState<TemplateInfo[]>([]);
  const [bot, setBot] = useState("");
  const [kind, setKind] = useState<"bot" | "instructions">("bot");
  const [error, setError] = useState<string | null>(null);
  const others = (view?.departments ?? []).filter((row) => row.id !== departmentId);
  const othersKey = others.map((row) => row.id).join(",");
  const load = useCallback(async (): Promise<void> => {
    try {
      setMine(await orgApi.templates(departmentId));
      const lists = await Promise.all(
        othersKey
          .split(",")
          .filter(Boolean)
          .map((id) => orgApi.templates(id)),
      );
      setTheirs(lists.flat().filter((row) => row.kind === "bot"));
    } catch (cause) {
      setError(errorText(cause));
    }
  }, [departmentId, othersKey]);
  useEffect(() => {
    void load();
  }, [load]);
  const act = async (run: () => Promise<unknown>): Promise<void> => {
    setError(null);
    try {
      await run();
      await load();
    } catch (cause) {
      setError(errorText(cause));
    }
  };
  const bots = sessions.profiles.filter(
    (row) => row.departmentId === departmentId && row.archivedAt === null,
  );
  const from = (id: string): string =>
    others.find((row) => row.id === id)?.name ?? "another department";
  return (
    <ListCard>
      {mine.length === 0 && theirs.length === 0 && (
        <EmptyState className="px-3 py-2.5">
          No templates yet. Publish a bot from here so other departments can copy it.
        </EmptyState>
      )}
      {mine.map((template) => (
        <div key={template.id} className={row}>
          <span className="text-ui min-w-0 flex-1 truncate">
            {template.name}{" "}
            <span className="text-muted-foreground">· {template.kind} · published here</span>
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void act(() => orgApi.unpublish(template.id))}
          >
            Unpublish
          </Button>
        </div>
      ))}
      {theirs.map((template) => (
        <div key={template.id} className={row}>
          <span className="text-ui min-w-0 flex-1 truncate">
            {template.name}{" "}
            <span className="text-muted-foreground">· from {from(template.departmentId)}</span>
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void act(async () => {
                await orgApi.copyTemplate(template.id, { departmentId });
                await refreshAll();
                void loadOrg();
              })
            }
          >
            Copy here
          </Button>
        </div>
      ))}
      {bots.length > 0 && (
        <div className={row}>
          <Select
            aria-label="Bot to publish"
            className="flex-1"
            value={bot}
            onChange={(event) => setBot(event.target.value)}
          >
            <option value="">Publish a bot…</option>
            {bots.map((one) => (
              <option key={one.id} value={one.id}>
                {one.name}
              </option>
            ))}
          </Select>
          <Select
            aria-label="What to publish"
            value={kind}
            onChange={(event) =>
              setKind(event.target.value === "instructions" ? "instructions" : "bot")
            }
          >
            <option value="bot">The bot</option>
            <option value="instructions">Its Instructions</option>
          </Select>
          <Button
            size="sm"
            variant="outline"
            disabled={bot === ""}
            onClick={() =>
              void act(() =>
                orgApi.publish({ kind, departmentId, botId: bot }).then(() => setBot("")),
              )
            }
          >
            Publish
          </Button>
        </div>
      )}
      {error !== null && <ErrorState className="m-2" message={error} />}
    </ListCard>
  );
}
