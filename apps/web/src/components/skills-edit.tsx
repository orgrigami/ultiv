/**
 * Skill editing and creation for the owner: a body editor in the detail
 * dialog, and an add-skill form per bot. Both are thin REST clients over
 * the same PUT the store treats as create-or-update (origin "owner"); the
 * raw SKILL.md text, frontmatter included, is what edits and what saves.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ErrorState } from "@/components/ui/empty-state";
import { api } from "@/lib/api";

const textareaClass =
  "h-80 w-full resize-y rounded-[10px] border bg-background p-3 font-mono text-xs";

function SkillForm({
  title,
  initialName,
  initialBody,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  title: string;
  initialName?: string;
  initialBody: string;
  busy: boolean;
  error: string | null;
  onSubmit: (name: string, body: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initialName ?? "");
  const [body, setBody] = useState(initialBody);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogTitle>{title}</DialogTitle>
        {initialName === undefined && (
          <input
            className="mt-2 w-full rounded-[10px] border bg-background px-3 py-2 font-mono text-sm"
            placeholder="skill-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        )}
        <textarea
          className={`mt-2 ${textareaClass}`}
          value={body}
          onChange={(event) => setBody(event.target.value)}
        />
        {error !== null && <ErrorState message={error} />}
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="outline" size="sm" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={busy || name.trim() === "" || body.trim() === ""}
            onClick={() => onSubmit(name.trim(), body)}
          >
            {busy ? "Saving…" : "Save skill"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The body editor for one existing skill (raw SKILL.md, frontmatter in). */
export function SkillEditor({
  profile,
  name,
  body,
  onSaved,
  onClose,
}: {
  profile: string;
  name: string;
  body: string;
  onSaved: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <SkillForm
      title={`Edit ${name}`}
      initialBody={body}
      busy={busy}
      error={error}
      onClose={onClose}
      onSubmit={(nextName, nextBody) => {
        void (async () => {
          setBusy(true);
          setError(null);
          try {
            await api.skillSave(profile, name, { body: nextBody });
            await onSaved();
            onClose();
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
          } finally {
            setBusy(false);
          }
        })();
      }}
    />
  );
}

/** The add-skill form for one bot's namespace (PUT creates, origin owner). */
export function SkillAdd({
  profile,
  onSaved,
  onClose,
}: {
  profile: string;
  onSaved: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <SkillForm
      title="Add skill"
      initialBody={"---\nname: \ndescription: \n---\n\n"}
      busy={busy}
      error={error}
      onClose={onClose}
      onSubmit={(nextName, nextBody) => {
        void (async () => {
          setBusy(true);
          setError(null);
          try {
            await api.skillSave(profile, nextName, { body: nextBody });
            await onSaved();
            onClose();
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
          } finally {
            setBusy(false);
          }
        })();
      }}
    />
  );
}
