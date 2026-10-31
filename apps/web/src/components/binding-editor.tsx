/**
 * Where a vault secret may be spent by `http_request`: hosts or URL
 * prefixes, methods, where the secret goes, and which bots may use it.
 * Every control is a 44px target on touch; it fits a 390px screen.
 */
import { TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import type { CredentialBinding, HttpAuthPlacement, ProfileInfo } from "@spreissen/contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import {
  allowlistGaps,
  draftOf,
  HTTP_METHODS,
  inputOf,
  PLACEMENTS,
  type BindingDraft,
} from "@/lib/binding-text";
import { cn } from "@/lib/utils";

/** A toggle chip: a checkbox that reads as a pill. */
function Chip(props: { label: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <label
      className={cn(
        "flex min-h-11 cursor-pointer items-center rounded-lg border px-3 text-sm select-none",
        props.checked ? "border-primary bg-primary/10 font-medium" : "text-muted-foreground",
      )}
    >
      <input
        type="checkbox"
        className="sr-only"
        checked={props.checked}
        onChange={(event) => props.onChange(event.target.checked)}
      />
      {props.label}
    </label>
  );
}

const toggle = <T,>(list: readonly T[], value: T, on: boolean): T[] =>
  on ? [...new Set([...list, value])] : list.filter((entry) => entry !== value);

function BotsField(props: {
  draft: BindingDraft;
  profiles: ProfileInfo[];
  update: (patch: Partial<BindingDraft>) => void;
}) {
  const { draft, profiles, update } = props;
  const gaps = allowlistGaps(profiles, draft.profiles);
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1.5 text-sm font-medium">Bots that may use it</legend>
      <div className="flex flex-wrap gap-2">
        <Chip
          label="All bots"
          checked={draft.profiles === null}
          onChange={(on) => update({ profiles: on ? null : [] })}
        />
        {profiles.map((profile) => (
          <Chip
            key={profile.id}
            label={profile.name}
            checked={draft.profiles?.includes(profile.id) === true}
            onChange={(on) => update({ profiles: toggle(draft.profiles ?? [], profile.id, on) })}
          />
        ))}
      </div>
      {gaps.length > 0 && (
        <p className="text-live flex items-start gap-1.5 text-xs">
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {gaps.map((p) => p.name).join(", ")} can't make web requests: their tool list leaves out
          http_request.
        </p>
      )}
    </fieldset>
  );
}

function AuthField(props: { draft: BindingDraft; update: (patch: Partial<BindingDraft>) => void }) {
  const { draft, update } = props;
  const needsName = PLACEMENTS.find((p) => p.value === draft.placement)?.needsName ?? false;
  return (
    <div className="flex flex-wrap gap-2">
      <Select
        aria-label="Where the secret goes"
        className="min-w-44 flex-1"
        value={draft.placement}
        onChange={(event) => update({ placement: event.target.value as HttpAuthPlacement })}
      >
        {PLACEMENTS.map((placement) => (
          <option key={placement.value} value={placement.value}>
            {placement.label}
          </option>
        ))}
      </Select>
      {needsName && (
        <Input
          className="min-w-32 flex-1"
          aria-label="Header, parameter or field name"
          placeholder={draft.placement === "header" ? "X-Api-Key" : "api_key"}
          value={draft.name}
          onChange={(event) => update({ name: event.target.value })}
        />
      )}
      {draft.placement === "header" && (
        <Input
          className="min-w-32 flex-1"
          aria-label="Value prefix"
          placeholder="Prefix (optional)"
          value={draft.prefix}
          onChange={(event) => update({ prefix: event.target.value })}
        />
      )}
    </div>
  );
}

export function BindingEditor(props: {
  itemId: string;
  binding: CredentialBinding | undefined;
  profiles: ProfileInfo[];
  onDone: () => void;
}) {
  const [draft, setDraft] = useState<BindingDraft>(() => draftOf(props.binding));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const update = (patch: Partial<BindingDraft>): void => setDraft({ ...draft, ...patch });
  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await action();
      props.onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="bg-muted/40 flex flex-col gap-3 rounded-lg border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void run(() => api.bindingSave(props.itemId, inputOf(draft)));
      }}
    >
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        Hosts or URL prefixes (one per line)
        <Textarea
          rows={2}
          placeholder={"api.example.com\nhttps://hooks.example.com/in/"}
          value={draft.hosts}
          onChange={(event) => update({ hosts: event.target.value })}
        />
      </label>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1.5 text-sm font-medium">Methods</legend>
        <div className="flex flex-wrap gap-2">
          {HTTP_METHODS.map((method) => (
            <Chip
              key={method}
              label={method}
              checked={draft.methods.includes(method)}
              onChange={(on) => update({ methods: toggle(draft.methods, method, on) })}
            />
          ))}
        </div>
      </fieldset>
      <AuthField draft={draft} update={update} />
      <BotsField draft={draft} profiles={props.profiles} update={update} />
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-4"
          checked={draft.allowLocalhostHttp}
          onChange={(event) => update({ allowLocalhostHttp: event.target.checked })}
        />
        Allow plain http to localhost (development only)
      </label>
      {error !== null && <p className="text-destructive text-sm">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy || draft.methods.length === 0}>
          {busy ? "Saving…" : "Save where it can be used"}
        </Button>
        {props.binding !== undefined && (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void run(() => api.bindingRemove(props.itemId))}
          >
            Stop all use
          </Button>
        )}
        <Button type="button" variant="ghost" disabled={busy} onClick={props.onDone}>
          Cancel
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">
        HTTPS only. The secret is added on the server and scrubbed from what the bot sees. Its first
        use on each host, and every request that changes data, asks you first.
      </p>
    </form>
  );
}
