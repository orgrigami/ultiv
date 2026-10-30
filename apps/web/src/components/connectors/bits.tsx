/** Small pieces the Connectors screen shares: status dot, switches, chips, secret rows. */
import { PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";
import type { McpState, VaultItemInfo } from "@ultiv/contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { NewKeyField } from "@/components/secure/new-key";
import { stateTone, type SecretRow } from "@/lib/connector-text";
import { cn } from "@/lib/utils";

const TONE = {
  good: "bg-ok",
  busy: "bg-live animate-pulse motion-reduce:animate-none",
  warn: "bg-amber-500",
  bad: "bg-destructive",
  off: "bg-muted-foreground/40",
} as const;

export function StatusDot({ state }: { state: McpState }) {
  return (
    <span aria-hidden className={cn("size-2 shrink-0 rounded-full", TONE[stateTone(state)])} />
  );
}

/** A full-width 44px switch row: label, optional hint, a checkbox on the right. */
export function ToggleRow(props: {
  label: string;
  hint?: string | undefined;
  checked: boolean;
  disabled?: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <label
      className={cn(
        "hover:bg-muted/60 flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 text-sm",
        props.disabled === true && "cursor-default opacity-60",
      )}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span>{props.label}</span>
        {props.hint !== undefined && (
          <span className="text-muted-foreground text-xs">{props.hint}</span>
        )}
      </span>
      <input
        type="checkbox"
        role="switch"
        className="peer sr-only"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.checked)}
      />
      <span
        aria-hidden
        className="bg-input peer-checked:bg-primary peer-focus-visible:ring-ring/50 relative h-6 w-10 shrink-0 rounded-full transition-colors peer-focus-visible:ring-3 motion-reduce:transition-none dark:bg-input/80 peer-checked:*:translate-x-4"
      >
        <span className="bg-background absolute top-0.5 left-0.5 size-5 rounded-full shadow-sm transition-transform motion-reduce:transition-none" />
      </span>
    </label>
  );
}

export function Chip(props: { label: string; checked: boolean; onChange: (on: boolean) => void }) {
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

const NEW_KEY = "__new";

/**
 * Header or env rows whose values come from vault items: pick one, or paste
 * a new key that goes straight to the vault (the form keeps only its id).
 */
export function SecretRows(props: {
  rows: SecretRow[];
  onChange: (rows: SecretRow[]) => void;
  items: VaultItemInfo[];
  namePlaceholder: string;
  addLabel: string;
  withPrefix: boolean;
  /** Names new vault items ("<connector> key"). */
  keyName?: string;
  /** Show the name as a static label (one-row cases like the OAuth secret). */
  hideName?: boolean;
}) {
  const [pasting, setPasting] = useState<number | null>(null);
  const [added, setAdded] = useState<VaultItemInfo[]>([]);
  const items = [
    ...props.items,
    ...added.filter((item) => !props.items.some((known) => known.id === item.id)),
  ];
  const set = (index: number, patch: Partial<SecretRow>): void =>
    props.onChange(props.rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));
  return (
    <div className="flex flex-col gap-2">
      {props.rows.map((row, index) => (
        <div key={index} className="flex flex-wrap items-center gap-2 rounded-lg border p-2">
          {props.hideName === true ? (
            <span className="min-w-28 flex-1 truncate text-sm">{props.namePlaceholder}</span>
          ) : (
            <Input
              className="min-w-28 flex-1"
              aria-label="Name"
              placeholder={props.namePlaceholder}
              value={row.name}
              onChange={(event) => set(index, { name: event.target.value })}
            />
          )}
          {props.withPrefix && (
            <Input
              className="w-24"
              aria-label="Value prefix"
              placeholder="Prefix"
              value={row.prefix}
              onChange={(event) => set(index, { prefix: event.target.value })}
            />
          )}
          <Select
            aria-label="Vault item"
            className="min-w-40 flex-[2]"
            value={pasting === index ? NEW_KEY : row.item}
            onChange={(event) => {
              if (event.target.value === NEW_KEY) return setPasting(index);
              setPasting(null);
              set(index, { item: event.target.value });
            }}
          >
            <option value="">Pick a vault item…</option>
            <option value={NEW_KEY}>Paste a new key…</option>
            {items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} ({item.masked})
              </option>
            ))}
          </Select>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Remove row"
            onClick={() => props.onChange(props.rows.filter((_, at) => at !== index))}
          >
            <XIcon />
          </Button>
          {pasting === index && (
            <NewKeyField
              label={`Key for ${row.name || props.namePlaceholder}`}
              name={`${props.keyName?.trim() || "Connector"} ${row.name || "key"}`}
              onCancel={() => setPasting(null)}
              onSaved={(item) => {
                setAdded((current) => [...current, item]);
                setPasting(null);
                set(index, { item: item.id });
              }}
            />
          )}
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        onClick={() =>
          props.onChange([
            ...props.rows,
            { name: "", item: "", prefix: props.withPrefix ? "Bearer " : "" },
          ])
        }
      >
        <PlusIcon />
        {props.addLabel}
      </Button>
      {items.length === 0 && (
        <p className="text-muted-foreground text-xs">
          Pick "Paste a new key…" to save one to your vault right here.
        </p>
      )}
    </div>
  );
}

/** Plain name/value rows for provider sign-in quirks (no secrets here). */
export function ParamRows(props: {
  rows: { name: string; value: string }[];
  onChange: (rows: { name: string; value: string }[]) => void;
  addLabel: string;
}) {
  const set = (index: number, patch: Partial<{ name: string; value: string }>): void =>
    props.onChange(props.rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));
  return (
    <div className="flex flex-col gap-2">
      {props.rows.map((row, index) => (
        <div key={index} className="flex flex-wrap items-center gap-2 rounded-lg border p-2">
          <Input
            className="min-w-28 flex-1 font-mono"
            aria-label="Parameter name"
            placeholder="access_type"
            autoComplete="off"
            spellCheck={false}
            value={row.name}
            onChange={(event) => set(index, { name: event.target.value })}
          />
          <Input
            className="min-w-28 flex-[2] font-mono"
            aria-label="Parameter value"
            placeholder="offline"
            autoComplete="off"
            spellCheck={false}
            value={row.value}
            onChange={(event) => set(index, { value: event.target.value })}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Remove parameter"
            onClick={() => props.onChange(props.rows.filter((_, at) => at !== index))}
          >
            <XIcon />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        onClick={() => props.onChange([...props.rows, { name: "", value: "" }])}
      >
        <PlusIcon />
        {props.addLabel}
      </Button>
    </div>
  );
}
