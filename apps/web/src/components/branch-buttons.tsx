/**
 * The transcript's branch controls (lib/branch.tsx): "Continue from here"
 * on a bot reply, and the owner's bubble with "Edit", which turns into an
 * inline editor whose send opens a NEW chat. Both render nothing outside a
 * chat (no BranchProvider). Like copy, the buttons show on hover or focus,
 * and always on touch screens.
 */
import { useState } from "react";
import { GitBranchIcon, PencilIcon } from "lucide-react";
import type { AttachmentRef } from "@spriessen/contracts";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useBranch } from "@/lib/branch";

const REVEAL =
  "opacity-0 group-hover/msg:opacity-100 group-focus-within/msg:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100";

/** "Continue from here in a new chat" on a finished bot reply. */
export function BranchFromHere({ at }: { at: number }) {
  const branch = useBranch();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (branch === null) return null;
  return (
    <Button
      type="button"
      variant="quiet"
      size="icon-sm"
      aria-label="Continue from here in a new chat"
      title={error ?? "Continue from here in a new chat"}
      className={REVEAL}
      disabled={busy}
      onClick={() => {
        setBusy(true);
        setError(null);
        branch
          .branch(at)
          .catch((cause: unknown) =>
            setError(cause instanceof Error ? cause.message : String(cause)),
          )
          .finally(() => setBusy(false));
      }}
    >
      <GitBranchIcon />
    </Button>
  );
}

/** The inline editor an owner message turns into; sending opens a new chat. */
function EditMessage({ at, text, onDone }: { at: number; text: string; onDone: () => void }) {
  const branch = useBranch();
  const [draft, setDraft] = useState(text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async (): Promise<void> => {
    if (branch === null || draft.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      await branch.edit(at, draft);
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };
  return (
    <div className="flex w-full flex-col gap-2">
      <Textarea
        autoFocus
        rows={Math.min(8, Math.max(2, draft.split("\n").length))}
        value={draft}
        aria-label="Edit your message"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") onDone();
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void send();
        }}
      />
      <p className="text-muted-foreground text-xs">
        Sends your edit in a new chat with everything before this message. This chat stays as it is.
      </p>
      {error !== null && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onDone} disabled={busy}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={() => void send()}
          disabled={busy || draft.trim() === ""}
        >
          Send in a new chat
        </Button>
      </div>
    </div>
  );
}

/** "Edit" under an owner message; the message becomes the editor while open. */
export function EditableOwnerText({
  at,
  text,
  attachments,
  children,
}: {
  at: number;
  text: string;
  attachments: readonly AttachmentRef[] | undefined;
  children: React.ReactNode;
}) {
  const branch = useBranch();
  const [editing, setEditing] = useState(false);
  // Attachments can't ride an edit yet: those messages keep only copy.
  const editable = branch !== null && (attachments === undefined || attachments.length === 0);
  if (editing) return <EditMessage at={at} text={text} onDone={() => setEditing(false)} />;
  return (
    <>
      {children}
      {editable && (
        <span className="-me-2 -mb-1.5 flex justify-end">
          <Button
            type="button"
            variant="quiet"
            size="icon-sm"
            aria-label="Edit this message in a new chat"
            title="Edit (sends in a new chat)"
            className={REVEAL}
            onClick={() => setEditing(true)}
          >
            <PencilIcon />
          </Button>
        </span>
      )}
    </>
  );
}
