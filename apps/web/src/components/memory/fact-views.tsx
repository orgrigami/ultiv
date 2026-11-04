/**
 * Fact row views: the current-fact row (forget; edit as "it changed" or "it
 * was wrong"; "no longer true"; confirm a guess — the same lifecycle a bot
 * runs with memory_update, bot-scope facts only), the history
 * view (superseded facts grouped under their successor, archived bucketed),
 * and the forgotten list with per-item restore.
 */
import { useState } from "react";
import { PencilIcon, RotateCcwIcon, Trash2Icon } from "lucide-react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api, type MemoryV2Fact } from "@/lib/api";
import { formatWhen } from "@/lib/format";
import * as t from "@/lib/memory-text";

const param = (shared: boolean, profileId: string): string => (shared ? "owner" : profileId);

const dayOf = (at: number): string => new Date(at).toISOString().slice(0, 10);

const meta = (fact: MemoryV2Fact): string => {
  const parts = [
    formatWhen(fact.createdAt),
    fact.tags.length > 0 ? fact.tags.join(", ") : null,
    fact.status !== "current" ? (fact.retired ?? fact.status) : null,
    fact.validTo !== undefined && fact.validTo !== null && fact.status === "current"
      ? t.untilMeta(dayOf(fact.validTo))
      : null,
    fact.trust === "untrusted" ? "unverified" : fact.basis === "inferred" ? t.inferredMeta : null,
  ];
  return parts.filter((part) => part !== null).join(" · ");
};

export function FactRow({
  fact,
  shared,
  profileId,
  reload,
}: {
  fact: MemoryV2Fact;
  shared: boolean;
  profileId: string;
  reload: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(fact.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (update: Parameters<typeof api.memoryFactUpdate>[2]): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.memoryFactUpdate(fact.id, param(shared, profileId), update);
      setEditing(false);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const save = (op: "change" | "correct"): void => {
    const next = draft.trim();
    if (next === "" || next === fact.text) {
      setEditing(false);
      return;
    }
    void act({ op, text: next });
  };

  return (
    <div className="flex flex-col gap-1 rounded-lg border px-2.5 py-2 text-sm">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="break-words">{fact.text}</p>
          <p className="text-muted-foreground mt-1 text-xs">
            {meta(fact)}
            {fact.basis === "inferred" && (
              <Button
                variant="link"
                size="sm"
                className="ml-1 h-auto p-0 text-xs"
                aria-label={t.confirmAria(fact.text)}
                disabled={busy}
                onClick={() => void act({ op: "confirm" })}
              >
                {t.confirmLabel}
              </Button>
            )}
          </p>
          {error !== null && <ErrorState message={error} className="mt-1" />}
        </div>
        {!shared && (
          <Button
            variant="ghost"
            size="icon"
            aria-label={t.editAria(fact.text)}
            onClick={() => {
              setDraft(fact.text);
              setEditing((current) => !current);
            }}
          >
            <PencilIcon />
          </Button>
        )}
        <ConfirmDialog
          title={t.forgetTitle}
          warning={t.forgetWarning(shared ? "Every bot" : "The bot")}
          confirmLabel="Forget"
          onConfirm={async () => {
            await api.memoryFactForget(fact.id, param(shared, profileId));
            await reload();
          }}
        >
          <Button variant="ghost" size="icon" aria-label={t.forgetAria(fact.text)}>
            <Trash2Icon />
          </Button>
        </ConfirmDialog>
      </div>
      {editing && (
        <div>
          <p className="text-muted-foreground text-xs">{t.editNote}</p>
          <Textarea
            aria-label={t.factTextLabel}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            className="mt-1"
          />
          <div className="mt-1 flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={busy} onClick={() => save("change")}>
              {busy ? t.savingLabel : t.changedLabel}
            </Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => save("correct")}>
              {t.wrongLabel}
            </Button>
            <ConfirmDialog
              title={t.endTitle}
              warning={t.endWarning}
              confirmLabel={t.endLabel}
              onConfirm={() => act({ op: "end" })}
            >
              <Button variant="ghost" size="sm" disabled={busy}>
                {t.endLabel}
              </Button>
            </ConfirmDialog>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setEditing(false)}>
              {t.cancelLabel}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function HistoryView({
  facts,
  profileId,
  reload,
}: {
  facts: MemoryV2Fact[];
  profileId: string;
  reload: () => Promise<void>;
}) {
  const history = facts.filter((fact) => fact.status === "superseded");
  const archived = facts.filter((fact) => fact.status === "archived");
  const current = facts.filter((fact) => fact.status === "current");
  const orphan = history.filter((fact) => fact.supersededBy === null);
  const chains = current
    .map((fact) => ({
      current: fact,
      old: history
        .filter((entry) => entry.supersededBy === fact.id)
        .sort((a, b) => a.createdAt - b.createdAt),
    }))
    .filter((chain) => chain.old.length > 0);
  return (
    <>
      <p className="text-muted-foreground text-xs">{t.historyIntro}</p>
      {chains.length === 0 && orphan.length === 0 && archived.length === 0 && (
        <EmptyState>No history yet — facts replaced or archived show up here.</EmptyState>
      )}
      {chains.map((chain) => (
        <div key={chain.current.id} className="flex flex-col gap-1">
          <FactRow fact={chain.current} shared={false} profileId={profileId} reload={reload} />
          {chain.old.map((fact) => (
            <div key={fact.id} className="border-border/60 ml-3 border-l pl-2 text-xs">
              <p className="text-muted-foreground break-words">{fact.text}</p>
              <p className="text-muted-foreground/70 mt-0.5">{formatWhen(fact.createdAt)}</p>
            </div>
          ))}
        </div>
      ))}
      {orphan.length > 0 && <HistoryBucket title={t.historyOrphans} facts={orphan} />}
      {archived.length > 0 && <HistoryBucket title={t.historyArchived} facts={archived} />}
    </>
  );
}

function HistoryBucket({ title, facts }: { title: string; facts: MemoryV2Fact[] }) {
  return (
    <section className="flex flex-col gap-1">
      <p className="text-muted-foreground mt-1 text-xs font-semibold">{title}</p>
      {facts.map((fact) => (
        <div key={fact.id} className="border-border/60 ml-3 border-l pl-2 text-xs">
          <p className="text-muted-foreground break-words">{fact.text}</p>
          <p className="text-muted-foreground/70 mt-0.5">{formatWhen(fact.createdAt)}</p>
        </div>
      ))}
    </section>
  );
}

export function ForgottenList({
  facts,
  profileId,
  reload,
}: {
  facts: MemoryV2Fact[];
  profileId: string;
  reload: () => Promise<void>;
}) {
  const forgotten = facts.filter((fact) => fact.status === "forgotten" && fact.text !== "");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="flex flex-col gap-1.5">
      <p className="text-muted-foreground mt-1 text-xs font-semibold">{t.forgottenTitle}</p>
      <p className="text-muted-foreground text-xs">{t.forgottenIntro}</p>
      {forgotten.length === 0 && (
        <p className="text-muted-foreground text-xs">{t.forgottenEmpty}</p>
      )}
      {error !== null && <ErrorState message={error} />}
      {forgotten.map((fact) => (
        <div
          key={fact.id}
          className="flex items-start gap-2 rounded-lg border border-dashed px-2.5 py-1.5 text-sm"
        >
          <div className="min-w-0 flex-1">
            <p className="text-muted-foreground break-words">{fact.text}</p>
            <p className="text-muted-foreground/70 text-xs">{formatWhen(fact.createdAt)}</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={busyId !== null}
            onClick={() => {
              setBusyId(fact.id);
              setError(null);
              void api
                .memoryFactRestore(fact.id, param(fact.scope === "owner", profileId))
                .then(() => reload())
                .catch((cause: unknown) =>
                  setError(cause instanceof Error ? cause.message : String(cause)),
                )
                .finally(() => setBusyId(null));
            }}
          >
            {busyId === fact.id ? (
              t.restoringLabel
            ) : (
              <>
                <RotateCcwIcon aria-hidden /> {t.restoreLabel}
              </>
            )}
          </Button>
        </div>
      ))}
      {forgotten.length > 0 && (
        <Badge variant="outline" className="w-fit">
          {forgotten.length} restorable
        </Badge>
      )}
    </section>
  );
}
