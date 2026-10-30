/**
 * The secure-input card: a bot asks for a key, the owner pastes it into
 * masked fields, and the browser posts it straight to the vault. The value
 * never reaches the chat, the bot, the transcript or the logs, and is never
 * shown back - only the vault item's name.
 */
import { CheckCircle2Icon, LockKeyholeIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { SecureField } from "./secure-field";

export interface SecretAsk {
  label: string;
  purpose: string;
  usedFor?: string;
  fields: { key: string; label: string }[];
}

export const secretAskOf = (input: unknown): SecretAsk | null => {
  if (typeof input !== "object" || input === null) return null;
  const ask = input as Partial<SecretAsk>;
  if (typeof ask.label !== "string" || !Array.isArray(ask.fields)) return null;
  return { purpose: "", ...ask } as SecretAsk;
};

type Phase =
  | { kind: "editing" }
  | { kind: "saving" }
  | { kind: "saved"; names: string[] }
  | { kind: "cancelled" };

export function SecretCard({
  callId,
  ask,
  who,
}: {
  callId: string;
  ask: SecretAsk;
  who?: string | undefined;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [phase, setPhase] = useState<Phase>({ kind: "editing" });
  const [error, setError] = useState<string | null>(null);
  const busy = phase.kind === "saving";
  const ready = ask.fields.every((field) => (values[field.key] ?? "").trim().length > 0);

  const save = async (): Promise<void> => {
    setPhase({ kind: "saving" });
    setError(null);
    try {
      const reply = await api.secretSubmit(callId, values);
      setValues({});
      setPhase({ kind: "saved", names: reply.stored.map((item) => item.name) });
    } catch (cause) {
      setPhase({ kind: "editing" });
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const cancel = async (): Promise<void> => {
    setPhase({ kind: "saving" });
    try {
      await api.secretCancel(callId);
      setValues({});
      setPhase({ kind: "cancelled" });
    } catch (cause) {
      setPhase({ kind: "editing" });
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  if (phase.kind === "saved" || phase.kind === "cancelled") {
    return (
      <div
        role="status"
        className="bg-card flex w-full items-start gap-2 rounded-xl border p-3 text-sm"
      >
        {phase.kind === "saved" ? (
          <>
            <CheckCircle2Icon className="text-ok mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              Saved to your vault as <span className="font-medium">{phase.names.join(", ")}</span>.{" "}
              {who ?? "Your bot"} can use it but never sees it.
            </span>
          </>
        ) : (
          <span className="text-muted-foreground">Cancelled. Nothing was stored.</span>
        )}
      </div>
    );
  }
  return (
    <form
      aria-label={`Secure input: ${ask.label}`}
      className="bg-card border-ring/60 flex w-full flex-col gap-3 rounded-xl border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && !busy) void save();
      }}
    >
      <div className="flex flex-col gap-1">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          <LockKeyholeIcon className="size-4 shrink-0" aria-hidden />
          {who ?? "Your bot"} needs {ask.label}
        </p>
        {ask.purpose !== "" && <p className="text-muted-foreground text-xs">{ask.purpose}</p>}
        {ask.usedFor !== undefined && (
          <p className="text-muted-foreground text-xs">Sent {ask.usedFor}.</p>
        )}
      </div>
      {ask.fields.map((field, index) => (
        <SecureField
          key={field.key}
          label={field.label}
          value={values[field.key] ?? ""}
          onChange={(value) => setValues((current) => ({ ...current, [field.key]: value }))}
          disabled={busy}
          autoFocus={index === 0}
          invalid={error !== null}
        />
      ))}
      <p className="text-muted-foreground text-xs">
        Goes straight to your encrypted vault. The bot never sees it.
      </p>
      {error !== null && (
        <p className="text-destructive text-xs" role="alert">
          Not saved: {error}.
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void cancel()}
        >
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={busy || !ready}>
          {busy ? "Saving…" : "Save to vault"}
        </Button>
      </div>
    </form>
  );
}
