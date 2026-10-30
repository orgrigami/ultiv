/**
 * The expanded bodies of tool calls, shaped for their kind: search hits as a
 * readable result list, web pages as rendered markdown, scripts as a terminal
 * transcript, credentialed requests as request/response, and everything
 * tabular as a definition-list record. Raw JSON stays only for calls whose
 * payload no lens knows. One scroll discipline: bodies never take the whole
 * transcript; they scroll inside their own bounded box.
 */
import { ArrowUpRightIcon, TerminalIcon } from "lucide-react";
import { useState } from "react";
import { LazyMarkdown } from "@/components/lazy-markdown";
import { Mark } from "@/components/state-mark";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockLine,
  CodeBlockTitle,
} from "@/components/ui/code-block";
import { useHighlightedCode } from "@/hooks/use-highlighted-code";
import { langOf } from "@/lib/file-meta";
import type { RecordField, SearchHit, ToolBodyData } from "@/lib/tool-text";
import { cn } from "@/lib/utils";

const BOX = "min-w-0 max-w-prose";

/** Highlighted code in the receipt style every body shares. */
function CodePlate({
  title,
  code,
  lang,
  icon,
  wrap = false,
  maxH = "max-h-72",
  copy = false,
}: {
  title: string;
  code: string;
  lang: string;
  icon?: React.ReactNode;
  wrap?: boolean;
  maxH?: string;
  copy?: boolean;
}) {
  const lines = useHighlightedCode(code, lang);
  return (
    <CodeBlock size="sm">
      <CodeBlockHeader>
        {icon}
        <CodeBlockTitle>{title}</CodeBlockTitle>
        {copy && (
          <CodeBlockActions>
            <CodeBlockCopyButton value={code} />
          </CodeBlockActions>
        )}
      </CodeBlockHeader>
      <CodeBlockContent wrap={wrap} className={cn(maxH, "overflow-y-auto")}>
        {lines.map((line, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: lines only append
          <CodeBlockLine key={index}>{line}</CodeBlockLine>
        ))}
      </CodeBlockContent>
    </CodeBlock>
  );
}

/** The query plate above a hit list: what was asked, in the small voice. */
function QueryPlate({ query }: { query: string }) {
  if (query === "") return null;
  return <p className="readout text-muted-foreground mb-1.5">“{query}”</p>;
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

function SearchBody({ query, hits }: { query: string; hits: readonly SearchHit[] }) {
  return (
    <div className={cn(BOX, "max-h-80 overflow-y-auto pr-1")}>
      <QueryPlate query={query} />
      <ul className="flex flex-col gap-1">
        {hits.map((hit, index) => (
          <li key={hit.url}>
            <a
              href={hit.url}
              target="_blank"
              rel="noreferrer"
              className="group hover:bg-muted/60 -mx-2 block rounded-lg px-2 py-1.5 outline-none"
            >
              <span className="readout text-muted-foreground/80 flex items-center gap-1.5">
                <span className="w-5 text-right">{String(index + 1).padStart(2, "0")}</span>
                <span className="truncate">{hit.site ?? hostOf(hit.url)}</span>
                {hit.date !== undefined && <span className="shrink-0">{hit.date}</span>}
                <ArrowUpRightIcon className="ms-auto size-3 shrink-0 opacity-0 transition-opacity group-focus-visible:opacity-100 group-hover:opacity-100" />
              </span>
              <span className="text-foreground mt-0.5 line-clamp-2 block text-sm font-medium leading-snug">
                {hit.title}
              </span>
              {hit.snippet !== undefined && (
                <span className="text-muted-foreground mt-0.5 line-clamp-2 block text-[0.8125rem] leading-snug">
                  {hit.snippet}
                </span>
              )}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

const statusTone = (status: number | undefined): string =>
  status === undefined
    ? "text-muted-foreground border-border"
    : status < 400
      ? "text-ok border-ok/30"
      : "text-signal border-signal/30";

function HttpBody({ method, url, status, sent, got }: Extract<ToolBodyData, { t: "http" }>) {
  return (
    <div className={cn(BOX, "flex flex-col gap-2")}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="readout rounded-md border px-1.5 py-0.5">{method}</span>
        <span className="font-mono text-xs break-all">{url}</span>
        {status !== undefined && (
          <span className={cn("readout rounded-md border px-1.5 py-0.5", statusTone(status))}>
            {String(status)}
          </span>
        )}
      </div>
      {sent !== undefined && sent !== "" && (
        <CodePlate title="sent" code={sent} lang="" wrap maxH="max-h-40" />
      )}
      {got !== undefined &&
        (got.trimStart().startsWith("{") || got.trimStart().startsWith("[") ? (
          <CodePlate title="got back" code={got} lang="json" wrap copy />
        ) : (
          <CodePlate title="got back" code={got} lang="" wrap copy />
        ))}
    </div>
  );
}

function TermBody({ command, output }: { command: string; output: string }) {
  return (
    <div className={cn(BOX, "flex flex-col gap-2")}>
      <CodePlate title="script" code={command} lang="bash" icon={<TerminalIcon />} wrap copy />
      {output !== "" && <CodePlate title="output" code={output} lang="ansi" wrap />}
    </div>
  );
}

function FileBody({ name, text }: { name: string; text: string }) {
  return (
    <div className={BOX}>
      <CodePlate title={name} code={text} lang={langOf(name)} copy maxH="max-h-80" />
    </div>
  );
}

function PageBody({ url, host, text }: { url: string; host: string; text: string }) {
  return (
    <div className={cn(BOX, "flex flex-col gap-2")}>
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="readout text-muted-foreground hover:text-foreground inline-flex w-fit items-center gap-1.5 outline-none"
      >
        {host}
        <ArrowUpRightIcon className="size-3" />
      </a>
      <div className="border-border max-h-96 overflow-y-auto border-l pl-4">
        <LazyMarkdown text={text} />
      </div>
    </div>
  );
}

function RecordBody({
  fields,
  note,
}: {
  fields: readonly RecordField[];
  note?: string | undefined;
}) {
  return (
    <div className={cn(BOX, "flex flex-col gap-1")}>
      {fields.length > 0 && (
        <dl className="divide-border/60 flex flex-col divide-y">
          {fields.map((field) => (
            <div
              key={field.k}
              className="grid grid-cols-[7rem_minmax(0,1fr)] gap-2 py-1 sm:grid-cols-[9rem_minmax(0,1fr)]"
            >
              <dt className="overline-plate truncate pt-1">{field.k}</dt>
              <dd className={cn("min-w-0 break-words text-sm", field.mono && "font-mono text-xs")}>
                {field.v}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {note !== undefined && <FoldText text={note} className="text-muted-foreground" />}
    </div>
  );
}

/** One input field: scalars in owner words, structures as mono JSON. */
function InputField({ k, v }: { k: string; v: unknown }) {
  const text =
    typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : null;
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-2 py-1 sm:grid-cols-[9rem_minmax(0,1fr)]">
      <dt className="overline-plate truncate pt-1">{k}</dt>
      <dd
        className={cn(
          "min-w-0 break-words text-sm",
          text === null && "font-mono text-xs whitespace-pre-wrap",
        )}
      >
        {text ?? JSON.stringify(v, null, 2)}
      </dd>
    </div>
  );
}

/** The call's input as readable rows, for calls whose payload no lens knows. */
export function InputRecord({ input }: { input: unknown }) {
  const fields =
    typeof input === "object" && input !== null
      ? Object.entries(input).filter(([, v]) => v !== null && v !== undefined)
      : [];
  if (fields.length === 0) return null;
  return (
    <dl className="divide-border/60 flex min-w-0 max-w-prose flex-col divide-y">
      {fields.map(([k, v]) => (
        <InputField key={k} k={k} v={v} />
      ))}
    </dl>
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
          <span className="font-medium">{item.slice(0, colon)}</span>
          <span className="text-muted-foreground"> · {item.slice(colon + 2)}</span>
        </span>
      </li>
    );
  }
  return (
    <li className="flex items-start gap-2 text-sm">
      <span aria-hidden className="bg-border mt-2 size-1 shrink-0 rounded-full" />
      <span className="min-w-0 break-words">{item}</span>
    </li>
  );
}

/** Plain output in its own shape: header lines become plate labels, bullet
 * groups become lists, and anything else stays one copyable plate. */
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
      <p key={`h${rows.length}`} className="overline-plate pt-1">
        {t.replace(/:$/, "")}
      </p>,
    );
  }
  flush();
  return <div className="flex min-w-0 max-w-prose flex-col">{rows}</div>;
}

/** The output as its best self: pretty JSON when it parses, its own list
 * shape when it has one, one copyable plate otherwise. */
function OutputPlate({ output }: { output: string }) {
  const trimmed = output.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return (
        <CodePlate
          title="output"
          code={JSON.stringify(JSON.parse(output), null, 2)}
          lang="json"
          wrap
          copy
        />
      );
    } catch {
      // fall through to the text renderer
    }
  }
  const bullets = output.split("\n").filter((line) => line.trimStart().startsWith("- ")).length;
  if (bullets >= 2) return <StructuredText text={output} />;
  return <CodePlate title="output" code={output} lang="" wrap copy />;
}

/** The fallback body for calls no lens shapes: input as rows, output as a plate. */
export function Receipts({ input, output }: { input: unknown; output?: string | undefined }) {
  const hasInput =
    input !== null &&
    input !== undefined &&
    (typeof input !== "object" || Object.keys(input as object).length > 0);
  const hasOutput = output !== undefined && output !== "";
  if (!hasInput && !hasOutput) return null;
  return (
    <div className={cn(BOX, "flex flex-col gap-2")}>
      {hasInput && <InputRecord input={input} />}
      {hasOutput && <OutputPlate output={output} />}
    </div>
  );
}

/** A long quote that folds instead of truncating: nothing is unreadable. */
export function FoldText({
  text,
  className,
  foldedClassName,
}: {
  text: string;
  className?: string;
  foldedClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const long = text.length > 480 || text.split("\n").length > 12;
  const folded = long && !open;
  return (
    <div className={className}>
      <p
        className={cn(
          "text-sm break-words whitespace-pre-wrap",
          folded &&
            cn(
              "max-h-40 overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]",
              foldedClassName,
            ),
        )}
      >
        {text}
      </p>
      {long && (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="readout text-muted-foreground hover:text-foreground mt-1 inline-flex cursor-pointer rounded-md px-1 py-0.5 outline-none"
        >
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

/** The error line of a failed call, in the payload's own words when possible. */
export function ErrorNote({ message }: { message: string }) {
  return (
    <p className="text-signal border-signal/25 bg-signal/5 flex items-start gap-2 rounded-lg border px-2.5 py-1.5 text-sm break-words">
      <Mark kind="error" tone="signal" className="mt-1 size-3.5" />
      <span className="min-w-0">{message}</span>
    </p>
  );
}

/** Dispatch: the shaped body for a tool call's expanded view. */
export function ToolBody({ data }: { data: ToolBodyData }) {
  switch (data.t) {
    case "search":
      return <SearchBody query={data.query} hits={data.hits} />;
    case "http":
      return <HttpBody {...data} />;
    case "term":
      return <TermBody command={data.command} output={data.output} />;
    case "file":
      return <FileBody name={data.name} text={data.text} />;
    case "page":
      return <PageBody url={data.url} host={data.host} text={data.text} />;
    case "record":
      return <RecordBody fields={data.fields} note={data.note} />;
    case "json":
      return null;
  }
}
