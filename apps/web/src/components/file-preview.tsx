/**
 * The shared file preview: a dialog (bottom sheet on phones) that shows a
 * bot-shared file inline when it is safe to — images, text/code, PDF, audio,
 * video — and otherwise says why not, with the download one tap away. Every
 * surface (chat cards, reply links, the Files tab, the task sheet) opens this.
 */
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { DownloadIcon, Maximize2Icon, Minimize2Icon, XIcon } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockLine,
  CodeBlockTitle,
} from "@/components/ui/code-block";
import { EmptyState } from "@/components/ui/empty-state";
import { LazyMarkdown } from "@/components/lazy-markdown";
import { Skeleton } from "@/components/ui/skeleton";
import { buttonVariants } from "@/components/ui/button";
import { useHighlightedCode } from "@/hooks/use-highlighted-code";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  formatBytes,
  kindLabel,
  langOf,
  MEDIA_PREVIEW_BYTES,
  previewKindOf,
  TEXT_PREVIEW_CHARS,
  type FileRef,
  type PreviewKind,
} from "@/lib/file-meta";

const TooLarge = ({ name }: { name: string }) => (
  <EmptyState>“{name}” is too large to preview. Download it instead.</EmptyState>
);

/** The artifact fetched once as text, shared by every text-shaped preview. */
function useArtifactText(id: string): { text: string | null; failed: boolean } {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const control = new AbortController();
    fetch(api.artifactUrl(id), { signal: control.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.text();
      })
      .then((body) => setText(body.slice(0, TEXT_PREVIEW_CHARS)))
      .catch(() => {
        if (!control.signal.aborted) setFailed(true);
      });
    return () => control.abort();
  }, [id]);
  return { text, failed };
}

/** Loading / failed states shared by the fetching previews. */
function FetchState({ failed }: { failed: boolean }) {
  return failed ? (
    <EmptyState>Couldn’t load this file. Download it instead.</EmptyState>
  ) : (
    <div role="status" aria-label="Loading the file" className="flex flex-col gap-2 py-2">
      <Skeleton className="h-40 rounded-2xl" />
      <Skeleton className="h-4 w-2/3 rounded-full" />
    </div>
  );
}

/** The preview's controls: the view toggle plus fullscreen. */
function PreviewControls({
  source,
  onToggle,
  onFullscreen,
}: {
  source: boolean;
  onToggle: () => void;
  /** Omitted inside fullscreen, where the button has no job. */
  onFullscreen?: (() => void) | undefined;
}) {
  return (
    <div className="flex shrink-0 items-center justify-end gap-1">
      <Button variant="outline" size="xs" onClick={onToggle}>
        {source ? "Rendered" : "Source"}
      </Button>
      {onFullscreen !== undefined && (
        <Button variant="ghost" size="icon-xs" aria-label="Fullscreen" onClick={onFullscreen}>
          <Maximize2Icon />
        </Button>
      )}
    </div>
  );
}

/** The file fullscreen: an overlay over the work surface — the chat column
 *  and the work pane — while the rail and the tab bar stay where they are. */
function useWorkSurface(): HTMLElement | null {
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setEl(document.querySelector("[data-work-surface]"));
  }, []);
  return el;
}

/** Markdown: rendered as prose by default, the source one toggle away. */
function MarkdownPreview({ file }: { file: FileRef }) {
  const { text, failed } = useArtifactText(file.id);
  const [source, setSource] = useState(false);
  const [full, setFull] = useState(false);
  const workSurface = useWorkSurface();
  if (text === null) return <FetchState failed={failed} />;

  // ```mermaid fences draw through the shared Diagram (lazy Pele, sanitized SVG).
  const rendered = (
    <article className="prose chat-prose md-doc dark:prose-invert max-w-none">
      <LazyMarkdown text={text} />
    </article>
  );

  const body = source ? (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <TextPreview file={file} text={text} wrap fill />
    </div>
  ) : (
    rendered
  );

  return (
    <>
      <div className={cn("flex flex-col gap-2", source && "h-full min-h-0")}>
        <PreviewControls
          source={source}
          onToggle={() => setSource((value) => !value)}
          onFullscreen={() => setFull(true)}
        />
        {body}
      </div>
      {full &&
        workSurface !== null &&
        createPortal(
          <div className="bg-background absolute inset-0 z-30 flex flex-col overflow-y-auto scrollbar-thin p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:pt-5">
            <div className="flex shrink-0 items-center justify-between gap-2 pb-2">
              <p className="min-w-0 truncate text-base font-semibold">{file.name}</p>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Exit fullscreen"
                  onClick={() => setFull(false)}
                >
                  <Minimize2Icon />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Close"
                  onClick={() => {
                    setFull(false);
                    setSource(false);
                  }}
                >
                  <XIcon />
                </Button>
              </div>
            </div>
            <div
              className={cn(
                "flex flex-col gap-2",
                source ? "h-full min-h-0 flex-none" : "min-w-0 flex-1",
              )}
            >
              <PreviewControls source={source} onToggle={() => setSource((value) => !value)} />
              {body}
            </div>
          </div>,
          workSurface,
        )}
    </>
  );
}

/** A quoted CSV/TSV parse: rows of fields; malformed tails stay as found. */
function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let cursor = 0; cursor < text.length; cursor += 1) {
    const char = text[cursor];
    if (quoted) {
      if (char === '"' && text[cursor + 1] === '"') {
        field += '"';
        cursor += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const CSV_ROWS = 100;
const CSV_COLS = 24;

/** CSV/TSV as a real table: hairline grid, mono numerals, capped. */
function DelimitedPreview({ file }: { file: FileRef }) {
  const { text, failed } = useArtifactText(file.id);
  const rows = useMemo(() => {
    if (text === null) return [];
    const delimiter = file.name.toLocaleLowerCase("en").endsWith(".tsv") ? "\t" : ",";
    return parseDelimited(text, delimiter)
      .slice(0, CSV_ROWS)
      .map((row) => row.slice(0, CSV_COLS));
  }, [text, file.name]);
  if (text === null) return <FetchState failed={failed} />;
  const [head, ...tail] = rows;
  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="max-h-[55dvh] overflow-auto">
        <table className="w-full border-collapse text-left text-xs">
          {head !== undefined && (
            <thead>
              <tr className="bg-muted/50">
                {head.map((cell, index) => (
                  <th
                    key={index}
                    className="section-label border-border border-b px-2.5 py-1.5 whitespace-nowrap"
                  >
                    {cell === "" ? `col ${index + 1}` : cell}
                  </th>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {tail.map((row, rowIndex) => (
              <tr key={rowIndex} className="border-border/60 border-t">
                {row.map((cell, cellIndex) => (
                  <td
                    key={cellIndex}
                    className="tnum border-border/40 border-r px-2.5 py-1 align-top last:border-r-0"
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {text.split("\n").length > CSV_ROWS && (
        <p className="text-muted-foreground border-border border-t px-2.5 py-1.5 text-xs">
          First {CSV_ROWS} rows. Download for the whole file.
        </p>
      )}
    </div>
  );
}

/** Text and code: fetched once, capped, highlighted when we bundle the language. */
function TextPreview({
  file,
  text: given,
  wrap = false,
  fill = false,
}: {
  file: FileRef;
  text?: string | undefined;
  /** Soft-wrap long lines (markdown source) instead of scrolling sideways. */
  wrap?: boolean | undefined;
  /** Stretch to the container's height; the code area scrolls inside. */
  fill?: boolean | undefined;
}) {
  const fetched = useArtifactText(file.id);
  const text = given ?? fetched.text;
  const failed = given === undefined && fetched.failed;
  const lines = useHighlightedCode(text ?? "", langOf(file.name));
  if (text === null) {
    return <FetchState failed={failed} />;
  }
  return (
    <CodeBlock className={cn(fill ? "h-full min-h-0" : "max-h-[60dvh]", "overflow-y-auto")}>
      <CodeBlockHeader>
        <CodeBlockTitle>{langOf(file.name) === "" ? "text" : langOf(file.name)}</CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton value={text} />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent wrap={wrap} className={fill ? "min-h-0 flex-1" : undefined}>
        {lines.map((line, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: lines only append
          <CodeBlockLine key={index}>{line}</CodeBlockLine>
        ))}
      </CodeBlockContent>
    </CodeBlock>
  );
}

/** The body for everything except text, which owns its fetch state. */
function InlineBody({ file, kind }: { file: FileRef; kind: PreviewKind }) {
  const src = api.artifactUrl(file.id);
  const oversized = file.bytes !== undefined && file.bytes > MEDIA_PREVIEW_BYTES;
  if (kind === "image") {
    if (oversized) return <TooLarge name={file.name} />;
    return (
      <img src={src} alt={file.name} loading="lazy" className="mx-auto max-h-[60dvh] rounded-lg" />
    );
  }
  if (kind === "pdf") {
    return <iframe src={src} title={file.name} className="h-[60dvh] w-full rounded-lg border" />;
  }
  if (kind === "audio") {
    return oversized ? (
      <TooLarge name={file.name} />
    ) : (
      <audio controls src={src} className="w-full" />
    );
  }
  if (kind === "video") {
    return oversized ? (
      <TooLarge name={file.name} />
    ) : (
      <video controls src={src} className="max-h-[60dvh] w-full rounded-lg" />
    );
  }
  return (
    <EmptyState>
      {kind === "blocked"
        ? "This file type can’t be previewed safely. Download it instead."
        : "No preview available for this file."}
    </EmptyState>
  );
}

/** The preview itself (no frame): the work pane and the dialog both show this. */
export function FilePreviewBody({ file }: { file: FileRef }) {
  const kind = previewKindOf(file.mime, file.name);
  return kind === "text" ? (
    file.bytes !== undefined && file.bytes > TEXT_PREVIEW_CHARS ? (
      <TooLarge name={file.name} />
    ) : (
      <TextPreview file={file} />
    )
  ) : kind === "markdown" ? (
    <MarkdownPreview file={file} />
  ) : kind === "csv" ? (
    <DelimitedPreview file={file} />
  ) : (
    <InlineBody file={file} kind={kind} />
  );
}

/** "Text file · 2 KB" under a file's name. */
export const fileSubtitle = (file: FileRef): string =>
  `${kindLabel(file.mime, file.name)}${file.bytes === undefined ? "" : ` · ${formatBytes(file.bytes)}`}`;

export function FileDownload({ file }: { file: FileRef }) {
  return (
    <a
      href={api.artifactUrl(file.id, true)}
      aria-label={`Download ${file.name}`}
      className={buttonVariants({ variant: "outline", size: "sm" })}
    >
      <DownloadIcon data-icon="inline-start" /> Download
    </a>
  );
}

/** The dialog form, for surfaces outside the app shell. */
export function FilePreviewDialog({ file, onClose }: { file: FileRef; onClose: () => void }) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <DialogTitle className="truncate">{file.name}</DialogTitle>
            <p className="text-muted-foreground mt-0.5 text-xs">{fileSubtitle(file)}</p>
          </div>
          <FileDownload file={file} />
        </div>
        <div className="mt-4">
          <FilePreviewBody file={file} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
