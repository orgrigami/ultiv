/**
 * The per-VM network allowlist editor (phase 4 slice 3, UI parity with the
 * REST field): the named hosts one home's VM may reach. Everything else is
 * denied — an empty list means the VM is fully offline. Used for the org VM
 * (Settings → Organization) and each department VM (its page); the save is
 * the same PATCH the API takes, audited server-side as org-net-allowlist /
 * department-net-allowlist. Validation is the contract's own
 * `netAllowlistProblem`, so the form refuses exactly what the server would.
 */
import { useEffect, useState } from "react";
import { netAllowlistProblem } from "@spriessen/contracts";
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";

const normalize = (raw: string): string => raw.trim().toLowerCase();

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((entry, i) => entry === b[i]);

export function NetAllowlistEditor({
  title,
  entries,
  open = false,
  onSave,
  meta,
}: {
  title: string;
  /** The home's current allowlist (a missing field reads as empty). */
  entries: readonly string[];
  /** Full network access: the allowlist is ignored, every host reachable. */
  open?: boolean;
  /** Persists the whole draft; throws with the server's words on refusal. */
  onSave: (draft: string[], open: boolean) => Promise<void>;
  /** One plain-language line under the title (what this VM is allowed). */
  meta: string;
}) {
  const [draft, setDraft] = useState<string[]>([...entries]);
  const [openDraft, setOpenDraft] = useState(open);
  const [newHost, setNewHost] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    setDraft([...entries]);
    setOpenDraft(open);
  }, [entries, open]);
  const problem = netAllowlistProblem(draft);
  const dirty = !sameList(draft, entries) || openDraft !== open;
  const add = (): void => {
    const host = normalize(newHost);
    if (host === "") return;
    if (draft.includes(host)) {
      setNewHost("");
      return;
    }
    const next = [...draft, host];
    const nextProblem = netAllowlistProblem(next);
    if (nextProblem !== null) {
      setNote({ ok: false, text: nextProblem });
      return;
    }
    setNote(null);
    setDraft(next);
    setNewHost("");
  };
  const remove = (host: string): void => {
    setNote(null);
    setDraft(draft.filter((entry) => entry !== host));
  };
  const save = async (): Promise<void> => {
    setBusy(true);
    setNote(null);
    try {
      await onSave(draft, openDraft);
      setNote({
        ok: true,
        text: openDraft
          ? "Saved. Full network access applies the next time this VM starts."
          : "Saved. Takes effect the next time this VM starts.",
      });
    } catch (cause) {
      setNote({ ok: false, text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-2 px-3 py-2.5">
      <span className="text-ui">
        {title}
        <span className="text-meta text-muted-foreground block">
          {openDraft ? "Open: this VM reaches everything — the hosts below are ignored." : meta}
        </span>
      </span>
      <label className="flex cursor-pointer items-start gap-2">
        <Checkbox
          className="mt-0.5"
          checked={openDraft}
          disabled={busy}
          onCheckedChange={(checked) => {
            setNote(null);
            setOpenDraft(checked === true);
          }}
        />
        <span className="text-ui">
          Full network access
          <span className="text-meta text-muted-foreground block">
            {openDraft
              ? "No restrictions: this VM reaches everything, including other machines on your network. The sandbox's network isolation is off — treat its bots accordingly."
              : "Off: the VM reaches only the hosts listed below, nothing else."}
          </span>
        </span>
      </label>
      {!openDraft && (
        <>
          {draft.length > 0 && (
            <ul className="flex flex-wrap gap-1.5" aria-label="Allowed hosts">
              {draft.map((host) => (
                <li
                  key={host}
                  className="bg-muted text-foreground flex items-center gap-1 rounded-md px-2 py-0.5 text-xs"
                >
                  {host}
                  <button
                    type="button"
                    aria-label={`Remove ${host}`}
                    disabled={busy}
                    onClick={() => remove(host)}
                    className="text-muted-foreground hover:text-foreground disabled:opacity-50"
                  >
                    <XIcon className="size-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-center gap-2">
            <Input
              value={newHost}
              placeholder="api.example.com or *.example.com"
              className="h-8 flex-1 text-sm"
              disabled={busy || draft.length >= 64}
              onChange={(event) => setNewHost(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  add();
                }
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy || normalize(newHost) === ""}
              onClick={add}
            >
              Add
            </Button>
          </div>
        </>
      )}
      <div className="flex items-center justify-end gap-3">
        {note !== null && (
          <span
            role={note.ok ? "status" : "alert"}
            className={note.ok ? "text-ok text-sm" : "text-destructive text-sm"}
          >
            {note.text}
          </span>
        )}
        <Button
          type="button"
          size="sm"
          disabled={busy || !dirty || (!openDraft && problem !== null)}
          onClick={() => void save()}
        >
          Save
        </Button>
      </div>
    </div>
  );
}
