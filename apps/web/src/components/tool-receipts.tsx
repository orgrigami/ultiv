/**
 * Receipts for tool calls no lens shapes (connector and MCP tools, anything
 * new): what was sent as labelled rows, what came back in its best shape.
 * Short scalars read as words, lists of words as chips, links as links,
 * a flat JSON object as rows; only deep structures stay JSON, highlighted.
 */
import { ArrowUpRightIcon } from "lucide-react";
import { CodePlate } from "@/components/tool-code-plate";
import { humanizeKey } from "@/lib/tool-values";
import { cn } from "@/lib/utils";

type Scalar = string | number | boolean;

const isScalar = (v: unknown): v is Scalar =>
  typeof v === "string" || typeof v === "number" || typeof v === "boolean";

const isLink = (v: string): boolean => /^https?:\/\/\S+$/.test(v);

const isWordList = (v: unknown): v is Scalar[] =>
  Array.isArray(v) && v.length > 0 && v.length <= 24 && v.every(isScalar);

/** Whether a value reads as words, chips or a link (else it shows as JSON). */
const readsAsWords = (v: unknown): boolean => isScalar(v) || isWordList(v);

/** A value as words, chips or a link; null when it needs JSON. */
function Words({ v }: { v: unknown }) {
  if (typeof v === "string" && isLink(v))
    return (
      <a
        href={v}
        target="_blank"
        rel="noreferrer"
        className="hover:text-foreground inline-flex max-w-full items-start gap-1 font-mono text-xs break-all underline-offset-2 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {v}
        <ArrowUpRightIcon aria-hidden className="mt-0.5 size-3 shrink-0" />
      </a>
    );
  if (isScalar(v)) return <span className="whitespace-pre-wrap">{String(v)}</span>;
  if (isWordList(v))
    return (
      <span className="flex flex-wrap gap-1">
        {v.map((item, index) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: static values
            key={index}
            className="bg-muted text-foreground/90 rounded-md px-1.5 py-px text-xs"
          >
            {String(item)}
          </span>
        ))}
      </span>
    );
  return null;
}

/** Labelled rows: the input of an unknown call, or a flat object it returned. */
export function FieldRows({ entries }: { entries: readonly (readonly [string, unknown])[] }) {
  return (
    <dl className="divide-border/60 flex min-w-0 flex-col divide-y">
      {entries.map(([k, v]) => {
        const plain = readsAsWords(v);
        return (
          <div
            key={k}
            className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-3 py-1.5 sm:grid-cols-[8.5rem_minmax(0,1fr)]"
          >
            <dt className="section-label truncate pt-0.5" title={k}>
              {humanizeKey(k)}
            </dt>
            <dd
              className={cn(
                "text-foreground/90 min-w-0 text-sm break-words",
                !plain && "font-mono text-xs whitespace-pre-wrap",
              )}
            >
              {plain ? <Words v={v} /> : JSON.stringify(v, null, 2)}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

const entriesOf = (value: unknown): [string, unknown][] =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.entries(value).filter(([, v]) => v !== null && v !== undefined && v !== "")
    : [];

/** The call's input as readable rows, for calls whose payload no lens knows. */
export function InputRecord({ input }: { input: unknown }) {
  const entries = entriesOf(input);
  if (entries.length === 0) return null;
  return (
    <div className="min-w-0 max-w-prose">
      <FieldRows entries={entries} />
    </div>
  );
}

/** Raw ids read as machine noise: dimmed wherever they appear in a row. */
function withDimIds(text: string): React.ReactNode[] {
  const parts = text.split(/(\(id:\s*[^)]+\))/g);
  return parts.map((part, index) =>
    // biome-ignore lint/suspicious/noArrayIndexKey: static split parts
    part.startsWith("(id:") ? (
      <span key={index} className="text-muted-foreground/60 font-mono text-xs">
        {part}
      </span>
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: static split parts
      <span key={index}>{part}</span>
    ),
  );
}

/** One bullet of a list-shaped output: "name: rest" reads as a titled row. */
function BulletRow({ item }: { item: string }) {
  const colon = item.indexOf(": ");
  if (colon > 0 && colon < 60) {
    return (
      <li className="flex items-start gap-2 text-sm">
        <span aria-hidden className="bg-border mt-2 size-1 shrink-0 rounded-full" />
        <span className="min-w-0 break-words">
          <span className="font-medium">{withDimIds(item.slice(0, colon))}</span>
          <span className="text-muted-foreground"> · {withDimIds(item.slice(colon + 2))}</span>
        </span>
      </li>
    );
  }
  return (
    <li className="flex items-start gap-2 text-sm">
      <span aria-hidden className="bg-border mt-2 size-1 shrink-0 rounded-full" />
      <span className="min-w-0 break-words">{withDimIds(item)}</span>
    </li>
  );
}

/** Plain output in its own shape: header lines become labels, bullet
 * groups become lists, and anything else stays one copyable block. */
function StructuredText({ text }: { text: string }) {
  const rows: React.ReactNode[] = [];
  let items: string[] = [];
  const flush = (): void => {
    if (items.length === 0) return;
    const batch = items;
    items = [];
    rows.push(
      <ul key={`g${rows.length}`} className="flex flex-col gap-1">
        {batch.map((item, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static rows
          <BulletRow key={index} item={item} />
        ))}
      </ul>,
    );
  };
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t === "") {
      flush();
      continue;
    }
    if (t.startsWith("- ")) {
      items.push(t.slice(2));
      continue;
    }
    flush();
    rows.push(
      <p key={`h${rows.length}`} className="section-label pt-1">
        {t.replace(/:$/, "")}
      </p>,
    );
  }
  flush();
  return <div className="flex min-w-0 max-w-prose flex-col">{rows}</div>;
}

/** A JSON object shallow enough to read as rows (scalars and word lists). */
const flatRecord = (value: unknown): [string, unknown][] | null => {
  const entries = entriesOf(value);
  if (entries.length === 0 || entries.length > 16) return null;
  return entries.every(([, v]) => readsAsWords(v)) ? entries : null;
};

/** The output as its best self: rows for a flat object, pretty JSON for the
 * rest that parses, its own list shape when it has one, one block otherwise. */
function OutputPlate({ output, title }: { output: string; title: string }) {
  const trimmed = output.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(output) as unknown;
      const rows = flatRecord(parsed);
      if (rows !== null) return <FieldRows entries={rows} />;
      return (
        <CodePlate title={title} code={JSON.stringify(parsed, null, 2)} lang="json" wrap copy />
      );
    } catch {
      // fall through to the text renderer
    }
  }
  const bullets = output.split("\n").filter((line) => line.trimStart().startsWith("- ")).length;
  if (bullets >= 1) return <StructuredText text={output} />;
  return <CodePlate title={title} code={output} lang="" wrap copy />;
}

/** The call's output, typed: the piece record bodies otherwise swallow. */
export function TypedOutput({ output }: { output: string }) {
  return (
    <div className="min-w-0 max-w-prose">
      <OutputPlate output={output} title="result" />
    </div>
  );
}

/** A small caption over one half of a receipt. */
const Caption = ({ children }: { children: string }) => <p className="section-label">{children}</p>;

/** The fallback body for calls no lens shapes: what was sent, what came back. */
export function Receipts({ input, output }: { input: unknown; output?: string | undefined }) {
  const sent = entriesOf(input);
  const hasOutput = output !== undefined && output.trim() !== "";
  if (sent.length === 0 && !hasOutput) return null;
  const both = sent.length > 0 && hasOutput;
  return (
    <div className="flex min-w-0 max-w-prose flex-col gap-3">
      {sent.length > 0 && (
        <section className="flex flex-col gap-0.5">
          {both && <Caption>Sent</Caption>}
          <FieldRows entries={sent} />
        </section>
      )}
      {hasOutput && (
        <section className="flex flex-col gap-1">
          {both && <Caption>Got back</Caption>}
          <OutputPlate output={output} title="result" />
        </section>
      )}
    </div>
  );
}
