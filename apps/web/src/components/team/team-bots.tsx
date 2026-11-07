/**
 * A team's bots: each opens its profile; "New bot here" starts one
 * in this team; "Move a bot here" brings in a bot from elsewhere
 * (never the main bot: it lives in the org).
 */
import { useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import type { ProfileInfo } from "@spriessen/contracts";
import { BotAvatar } from "@/components/bot-avatar";
import { NewBotDialog } from "@/components/new-bot-dialog";
import { Button } from "@/components/ui/button";
import { ListCard } from "@/components/ui/list-card";
import { RowButton } from "@/components/ui/row-button";
import { EmptyState } from "@/components/ui/empty-state";
import { SectionHeader } from "@/components/ui/section-header";
import { Select } from "@/components/ui/select";
import { api } from "@/lib/api";
import { useApp } from "@/lib/app-state";
import { loadOrg } from "@/lib/use-org";

function MoveHere({ teamId, others }: { teamId: string; others: ProfileInfo[] }) {
  const { refreshAll } = useApp();
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (others.length === 0) return null;
  const move = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.updateProfile(pick, { teamId });
      setPick("");
      await refreshAll();
      void loadOrg();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-1 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <Select
          aria-label="Move a bot here"
          className="flex-1"
          value={pick}
          onChange={(event) => setPick(event.target.value)}
        >
          <option value="">Move a bot here…</option>
          {others.map((bot) => (
            <option key={bot.id} value={bot.id}>
              {bot.name}
            </option>
          ))}
        </Select>
        <Button
          size="sm"
          variant="outline"
          disabled={pick === "" || busy}
          onClick={() => void move()}
        >
          Move
        </Button>
      </div>
      {error !== null && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
    </div>
  );
}

export function TeamBots({ teamId }: { teamId: string }) {
  const { sessions, mainId, refreshAll } = useApp();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const visible = sessions.profiles.filter((bot) => bot.archivedAt === null);
  const here = visible.filter((bot) => bot.teamId === teamId);
  const others = visible.filter((bot) => bot.teamId !== teamId && bot.id !== mainId);
  const open = (id: string): void => void navigate({ to: "/crew/$botId", params: { botId: id } });
  return (
    <section aria-label="Bots" className="flex flex-col gap-2">
      <SectionHeader
        title="Bots"
        action={
          <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
            <PlusIcon /> New bot here
          </Button>
        }
      />
      <ListCard>
        {here.length === 0 ? (
          <EmptyState className="px-3 py-2.5">
            No bots here yet. Start one, or move one in.
          </EmptyState>
        ) : (
          <ul aria-label="Bots in this team" className="divide-border flex flex-col divide-y">
            {here.map((bot) => (
              <li key={bot.id}>
                <RowButton
                  onClick={() => open(bot.id)}
                  className="hover:bg-muted flex min-h-11 w-full items-center gap-3 px-3 py-2"
                >
                  <BotAvatar id={bot.id} name={bot.name} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="text-ui block truncate font-medium">{bot.name}</span>
                    <span className="text-meta text-muted-foreground block truncate">
                      {bot.description !== "" ? bot.description : "No role yet"}
                    </span>
                  </span>
                  <ChevronRightIcon className="text-muted-foreground size-4 shrink-0" />
                </RowButton>
              </li>
            ))}
          </ul>
        )}
        <MoveHere teamId={teamId} others={others} />
      </ListCard>
      <NewBotDialog
        teamId={teamId}
        open={creating}
        onOpenChange={setCreating}
        onCreated={async (id) => {
          await refreshAll();
          open(id);
        }}
      />
    </section>
  );
}
