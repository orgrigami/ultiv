/**
 * One tidy suggestion. Accept applies it (forgetting kinds warn first);
 * "Not now" is a permanent reject and says so. Merge/stale cards let the
 * owner adjust the affected fact text before accepting — the edit is applied
 * as tombstone + re-add, then the proposal is accepted (other kinds have no
 * sensible fact edit, so they offer accept/reject only).
 */
import { useState } from "react";
import { ErrorState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api, type MemoryV2Fact, type MemoryV2Proposal } from "@/lib/api";
import * as t from "@/lib/memory-text";

interface CardProps {
  proposal: MemoryV2Proposal;
  facts: MemoryV2Fact[];
  profileId: string;
  reload: () => Promise<void>;
}

/** Kinds whose accept forgets facts — those cards must warn. */
const FORGETS = new Set(["secret", "conflict"]);
/** Kinds where editing the affected fact text before accept makes sense. */
const EDITABLE = new Set(["merge", "stale"]);

export function ProposalCard({ proposal, facts, profileId, reload }: CardProps) {
  const affected = proposal.factIds
    .map((id) => facts.find((fact) => fact.id === id))
    .filter((fact) => fact !== undefined);
  const forgets = FORGETS.has(proposal.kind);
  const [busy, setBusy] = useState<"accept" | "reject" | "edit" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});

  const decide = async (verdict: "accept" | "reject"): Promise<void> => {
    setBusy(verdict);
    setError(null);
    try {
      await api.memoryProposalDecide(proposal.id, verdict, profileId);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const acceptEdited = async (): Promise<void> => {
    setBusy("edit");
    setError(null);
    try {
      for (const [id, text] of Object.entries(edits)) {
        const fact = affected.find((entry) => entry.id === id);
        const next = text.trim();
        if (fact === undefined || next === "" || next === fact.text) continue;
        await api.memoryFactForget(id, profileId);
        await api.profileMemoryAdd(profileId, next);
      }
      await api.memoryProposalDecide(proposal.id, "accept", profileId);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const canEdit = EDITABLE.has(proposal.kind) && affected.length > 0;

  return (
    <div className="rounded-lg border px-2.5 py-2 text-sm">
      <div className="flex items-center gap-2">
        <Badge variant="secondary" className="w-fit">
          {t.PROPOSAL_KINDS[proposal.kind] ?? proposal.kind}
        </Badge>
      </div>
      <p className="mt-1.5 break-words">{proposal.summary}</p>
      {affected.length > 0 && (
        <div className="text-muted-foreground mt-1.5 text-xs">
          <p>{t.affectedTitle}</p>
          <ul className="mt-1 flex flex-col gap-1">
            {affected.map((fact) => (
              <li key={fact.id} className="border-border/60 border-l pl-2 break-words">
                {fact.text}
                {fact.status !== "current" && ` (${fact.status})`}
              </li>
            ))}
          </ul>
        </div>
      )}
      {forgets && <p className="text-destructive mt-1.5 text-xs">{t.willForget}</p>}
      {error !== null && <ErrorState message={error} className="mt-1.5" />}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={busy !== null}
          onClick={() => void decide("accept")}
        >
          {busy === "accept" ? t.acceptingLabel : t.acceptLabel}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy !== null}
          title={t.rejectNote}
          onClick={() => void decide("reject")}
        >
          {busy === "reject" ? t.rejectingLabel : t.rejectLabel}
        </Button>
        {canEdit && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy !== null}
            onClick={() =>
              setEdits(Object.fromEntries(affected.map((fact) => [fact.id, fact.text])))
            }
          >
            {t.editAcceptLabel}
          </Button>
        )}
        <span className="text-muted-foreground ml-auto text-xs">{t.rejectNote}</span>
      </div>
      {canEdit && Object.keys(edits).length > 0 && (
        <EditForm
          affected={affected}
          edits={edits}
          busy={busy === "edit"}
          onEdit={(id, text) => setEdits((current) => ({ ...current, [id]: text }))}
          onCancel={() => setEdits({})}
          onAccept={() => void acceptEdited()}
        />
      )}
    </div>
  );
}

function EditForm({
  affected,
  edits,
  busy,
  onEdit,
  onCancel,
  onAccept,
}: {
  affected: MemoryV2Fact[];
  edits: Record<string, string>;
  busy: boolean;
  onEdit: (id: string, text: string) => void;
  onCancel: () => void;
  onAccept: () => void;
}) {
  return (
    <div className="border-border mt-2 flex flex-col gap-2 border-t pt-2">
      <p className="text-muted-foreground text-xs">
        Adjust the text, then save — the old fact is tombstoned and your version is re-added before
        the suggestion applies.
      </p>
      {affected.map((fact) => (
        <label key={fact.id} className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">Fact text</span>
          <Textarea
            aria-label="Affected fact text"
            value={edits[fact.id] ?? fact.text}
            onChange={(event) => onEdit(fact.id, event.target.value)}
          />
        </label>
      ))}
      <div className="flex gap-2">
        <Button variant="outline" size="sm" disabled={busy} onClick={onAccept}>
          {busy ? "Working…" : t.saveAcceptLabel}
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
          {t.cancelLabel}
        </Button>
      </div>
    </div>
  );
}
