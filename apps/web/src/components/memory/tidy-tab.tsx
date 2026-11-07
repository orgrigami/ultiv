/**
 * Tidy tab: the Sunday tidy's suggestions (accept / not now / edit & accept),
 * run-tidy-now with real feedback, and the purge. Nothing changes until the
 * owner accepts.
 */
import { ListChecksIcon } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ErrorState, EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ProposalCard } from "@/components/memory/proposal-card";
import type { MemoryData } from "@/components/memory/memory-panel";
import { api } from "@/lib/api";
import * as t from "@/lib/memory-text";

interface TabProps {
  data: MemoryData;
  profileId: string;
  name: string;
  reload: () => Promise<void>;
}

export function TidyTab({ data, profileId, reload }: TabProps) {
  const open = data.proposals.filter((proposal) => proposal.status === "open");
  return (
    <>
      <p className="text-muted-foreground text-xs">{t.tidyIntro}</p>
      <div className="flex flex-col gap-2">
        {data.openCount > 0 && (
          <Badge variant="secondary" className="w-fit">
            <ListChecksIcon className="size-3" /> {t.tidyOpenBadge(data.openCount)}
          </Badge>
        )}
        {open.length === 0 && <EmptyState>{t.tidyEmpty}</EmptyState>}
        {open.map((proposal) => (
          <ProposalCard
            key={proposal.id}
            proposal={proposal}
            facts={data.facts}
            chats={data.chats}
            profileId={profileId}
            reload={reload}
          />
        ))}
        <RunTidy onDone={reload} />
        <PurgeControl data={data} profileId={profileId} reload={reload} />
      </div>
    </>
  );
}

function RunTidy({ onDone }: { onDone: () => Promise<void> }) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (): Promise<void> => {
    setRunning(true);
    setError(null);
    try {
      const reply = await api.memoryTidyRun();
      setResult(reply.proposals);
      await onDone();
    } catch (cause) {
      setResult(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" disabled={running} onClick={() => void run()}>
          {running ? t.tidyRunning : t.tidyRunLabel}
        </Button>
        {result !== null && !running && (
          <span className="text-muted-foreground text-xs" aria-live="polite">
            {t.tidyResult(result)}
          </span>
        )}
      </div>
      {error !== null && <ErrorState message={error} />}
    </div>
  );
}

function PurgeControl({
  data,
  profileId,
  reload,
}: {
  data: MemoryData;
  profileId: string;
  reload: () => Promise<void>;
}) {
  const pending = data.facts.filter((fact) => fact.status === "forgotten" && fact.text !== "");
  return (
    <ConfirmDialog
      title={t.purgeTitle}
      warning={t.purgeWarning}
      detail={
        pending.length > 0 ? (
          <div className="mt-2 text-sm">
            <p className="text-muted-foreground text-xs">
              {t.purgeListTitle} ({pending.length})
            </p>
            <ul className="mt-1 flex max-h-40 flex-col gap-1 overflow-y-auto text-xs">
              {pending.map((fact) => (
                <li key={fact.id} className="break-words">
                  {fact.text}
                </li>
              ))}
            </ul>
          </div>
        ) : undefined
      }
      typed={pending.length > 0 ? String(pending.length) : undefined}
      confirmLabel="Purge"
      onConfirm={async () => {
        await api.memoryPurge(profileId, pending.length);
        await reload();
      }}
    >
      <Button variant="ghost-destructive" size="sm">
        {t.purgeLabel} ({pending.length})
      </Button>
    </ConfirmDialog>
  );
}
