/**
 * The expanded bodies of tool calls, shaped for their kind: search hits as a
 * readable result list, web pages as rendered markdown, scripts as a terminal
 * transcript, credentialed requests as request/response, and everything
 * tabular as a definition-list record. Raw JSON stays only for calls whose
 * payload no lens knows. One scroll discipline: bodies never take the whole
 * transcript; they scroll inside their own bounded box.
 */
import { ArrowUpRightIcon, TerminalIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { LazyMarkdown } from "@/components/lazy-markdown";
import { Mark } from "@/components/state-mark";
import { CodePlate } from "@/components/tool-code-plate";
import { TypedOutput } from "@/components/tool-receipts";
import { langOf } from "@/lib/file-meta";
import type { RecordField, SearchHit, ToolBodyData } from "@/lib/tool-text";
import { cn } from "@/lib/utils";

const BOX = "min-w-0 max-w-prose";

/** The query line above a hit list: what was asked. */
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
              className="group hover:bg-muted/60 -mx-2 block rounded-lg px-2 py-1.5 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <span className="readout text-muted-foreground/80 flex items-center gap-1.5">
                <span className="w-5 text-right">{String(index + 1).padStart(2, "0")}</span>
                <span className="truncate">{hit.site ?? hostOf(hit.url)}</span>
                {hit.date !== undefined && <span className="shrink-0">{hit.date}</span>}
                <ArrowUpRightIcon className="text-muted-foreground ms-auto size-3 shrink-0 opacity-50 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
              </span>
              <span className="text-foreground mt-0.5 line-clamp-2 block text-sm font-medium leading-snug">
                {hit.title}
              </span>
              {hit.snippet !== undefined && (
                <span className="text-muted-foreground mt-0.5 line-clamp-2 block text-sm leading-snug">
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
      {/* Method and status stay together; the address takes its own line. */}
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex items-center gap-1.5">
          <span className="readout rounded-md border px-1.5 py-0.5">{method}</span>
          {status !== undefined && (
            <span className={cn("readout rounded-md border px-1.5 py-0.5", statusTone(status))}>
              {String(status)}
            </span>
          )}
        </div>
        <span className="text-muted-foreground font-mono text-xs break-all">{url}</span>
      </div>
      {sent !== undefined && sent !== "" && (
        <CodePlate title="sent" code={sent} lang="" wrap maxH="max-h-40" />
      )}
      {got !== undefined && (
        <CodePlate
          title="got back"
          code={prettyJson(got)}
          lang={jsonish(got) ? "json" : ""}
          wrap
          copy
        />
      )}
    </div>
  );
}

const jsonish = (text: string): boolean => /^\s*[[{]/.test(text);

/** JSON text indented for reading; anything else as it came. */
function prettyJson(text: string): string {
  if (!jsonish(text)) return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** A script and what it printed: two bounded plates, never an empty one. */
function TermBody({ command, output }: { command: string; output: string }) {
  if (command === "" && output === "") return null;
  return (
    <div className={cn(BOX, "flex flex-col gap-2")}>
      {command !== "" && (
        <CodePlate
          title="script"
          code={command}
          lang="bash"
          icon={<TerminalIcon />}
          wrap
          copy
          maxH="max-h-48"
        />
      )}
      {output !== "" && <CodePlate title="output" code={output} lang="ansi" wrap copy />}
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
        className="readout text-muted-foreground hover:text-foreground inline-flex w-fit items-center gap-1.5 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
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
              className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-3 py-1.5 sm:grid-cols-[8.5rem_minmax(0,1fr)]"
            >
              <dt className="section-label truncate pt-0.5">{field.k}</dt>
              <dd
                className={cn(
                  "text-foreground/90 min-w-0 text-sm break-words",
                  field.mono && "font-mono text-xs",
                )}
              >
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
        <Button
          variant="quiet"
          size="xs"
          className="mt-1"
          onClick={() => setOpen((value) => !value)}
        >
          {open ? "Show less" : "Show more"}
        </Button>
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
    case "output":
      return <TypedOutput output={data.text} />;
    case "json":
      return null;
  }
}
