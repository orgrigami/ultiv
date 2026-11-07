/**
 * One tidy suggestion. Accept applies it (forgetting kinds warn first; a
 * conflict shows both claims with their evidence and the owner keeps one,
 * `conflict-choice.tsx`);
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
import { ConflictChoice } from "@/components/memory/conflict-choice";
import { api, type MemoryV2Chat, type MemoryV2Fact, type MemoryV2Proposal } from "@/lib/api";
import * as t from "@/lib/memory-text";

interface CardProps {
  proposal: MemoryV2Proposal;
  facts: MemoryV2Fact[];
  /** The bot's chats by conversation id, for "Learned in …". */
  chats?: Record<string, MemoryV2Chat> | undefined;
  profileId: string;
  reload: () => Promise<void>;
}

/** Kinds whose accept forgets facts — those cards must warn. */
const FORGETS = new Set(["secret"]);
/** Kinds where editing the affected fact text before accept makes sense. */
const EDITABLE = new Set(["merge", "stale"]);

export function ProposalCard({ proposal, facts, chats, profileId, reload }: CardProps) {
  const affected = proposal.factIds
    .map((id) => facts.find((fact) => fact.id === id))
    .filter((fact) => fact !== undefined);
  const forgets = FORGETS.has(proposal.kind);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const { busy, keeping, error, decide, acceptEdited } = useDecide(proposal.id, profileId, reload);
  const canEdit = EDITABLE.has(proposal.kind) && affected.length > 0;
  const [older, newer] = affected;
  const conflict =
    proposal.kind === "conflict" && older !== undefined && newer !== undefined
      ? { older, newer }
      : null;

  return (
    <div className="rounded-lg border px-2.5 py-2 text-sm">
      <div className="flex items-center gap-2">
        <Badge variant="secondary" className="w-fit">
          {t.PROPOSAL_KINDS[proposal.kind] ?? proposal.kind}
        </Badge>
      </div>
      <p className="mt-1.5 break-words">{proposal.summary}</p>
      {conflict !== null && (
        <ConflictChoice
          older={conflict.older}
          newer={conflict.newer}
          chats={chats}
          busy={busy !== null}
          keeping={keeping}
          onKeep={(id) => void decide("accept", id)}
        />
      )}
      {conflict === null && affected.length > 0 && <AffectedList affected={affected} />}
      {forgets && <p className="text-destructive mt-1.5 text-xs">{t.willForget}</p>}
      {error !== null && <ErrorState message={error} className="mt-1.5" />}
      <CardActions
        accept={proposal.kind !== "conflict"}
        busy={busy}
        canEdit={canEdit}
        onAccept={() => void decide("accept")}
        onReject={() => void decide("reject")}
        onEdit={() => setEdits(Object.fromEntries(affected.map((fact) => [fact.id, fact.text])))}
      />
      {canEdit && Object.keys(edits).length > 0 && (
        <EditForm
          affected={affected}
          edits={edits}
          busy={busy === "edit"}
          onEdit={(id, text) => setEdits((current) => ({ ...current, [id]: text }))}
          onCancel={() => setEdits({})}
          onAccept={() => void acceptEdited(affected, edits)}
        />
      )}
    </div>
  );
}

type Busy = "accept" | "reject" | "edit" | null;

/** The card's requests: decide (a conflict's accept names the fact kept) and edit-then-accept. */
function useDecide(proposalId: string, profileId: string, reload: () => Promise<void>) {
  const [busy, setBusy] = useState<Busy>(null);
  const [keeping, setKeeping] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const attempt = async (state: Busy, work: () => Promise<void>): Promise<void> => {
    setBusy(state);
    setError(null);
    try {
      await work();
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
      setKeeping(null);
    }
  };
  const decide = (verdict: "accept" | "reject", keep?: string): Promise<void> => {
    setKeeping(keep ?? null);
    return attempt(verdict, async () => {
      await api.memoryProposalDecide(proposalId, verdict, profileId, keep);
    });
  };
  const acceptEdited = (affected: MemoryV2Fact[], edits: Record<string, string>): Promise<void> =>
    attempt("edit", async () => {
      for (const [id, text] of Object.entries(edits)) {
        const fact = affected.find((entry) => entry.id === id);
        const next = text.trim();
        if (fact === undefined || next === "" || next === fact.text) continue;
        await api.memoryFactForget(id, profileId);
        await api.profileMemoryAdd(profileId, next);
      }
      await api.memoryProposalDecide(proposalId, "accept", profileId);
    });
  return { busy, keeping, error, decide, acceptEdited };
}

function AffectedList({ affected }: { affected: MemoryV2Fact[] }) {
  return (
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
  );
}

/** Accept (not for a conflict: its sides carry "Keep this one"), Not now, Edit & accept. */
function CardActions({
  accept,
  busy,
  canEdit,
  onAccept,
  onReject,
  onEdit,
}: {
  accept: boolean;
  busy: Busy;
  canEdit: boolean;
  onAccept: () => void;
  onReject: () => void;
  onEdit: () => void;
}) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {accept && (
        <Button variant="outline" size="sm" disabled={busy !== null} onClick={onAccept}>
          {busy === "accept" ? t.acceptingLabel : t.acceptLabel}
        </Button>
      )}
      <Button
        variant="ghost"
        size="sm"
        disabled={busy !== null}
        title={t.rejectNote}
        onClick={onReject}
      >
        {busy === "reject" ? t.rejectingLabel : t.rejectLabel}
      </Button>
      {canEdit && (
        <Button variant="ghost" size="sm" disabled={busy !== null} onClick={onEdit}>
          {t.editAcceptLabel}
        </Button>
      )}
      <span className="text-muted-foreground ml-auto text-xs">{t.rejectNote}</span>
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
