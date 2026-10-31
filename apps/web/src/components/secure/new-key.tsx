/**
 * "Paste a new key" inside a form: the value goes straight to the vault as a
 * Key item and the form keeps only the item's id. Never echoed back.
 */
import type { VaultItemInfo } from "@spreissen/contracts";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { SecureField } from "./secure-field";

export function NewKeyField(props: {
  label: string;
  /** Vault item name, e.g. "context7 key". */
  name: string;
  onSaved: (item: VaultItemInfo) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const item = await api.vaultCreate({
        kind: "key",
        name: props.name.slice(0, 120),
        key: { service: props.name.slice(0, 120), secret: value.trim() },
      });
      setValue("");
      props.onSaved(item);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="bg-muted/40 flex w-full flex-col gap-2 rounded-lg p-2">
      <SecureField
        label={props.label}
        value={value}
        onChange={setValue}
        disabled={busy}
        autoFocus
        invalid={error !== null}
      />
      <p className="text-muted-foreground text-xs">
        Saved encrypted in your vault. Bots never see it.
      </p>
      {error !== null && (
        <p role="alert" className="text-destructive text-xs">
          Not saved: {error}.
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={props.onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={busy || value.trim().length === 0}
          onClick={() => void save()}
        >
          {busy ? "Saving…" : "Save key"}
        </Button>
      </div>
    </div>
  );
}
