/**
 * The file preview's bodies, one per kind. Each one FILLS the space it is
 * given (the work pane, the sheet, fullscreen) and owns its single scroll
 * area, so a long file never scrolls inside a box inside a scrolling page.
 * The frame, toolbar and fullscreen live in file-preview.tsx.
 */
import { useEffect, useMemo, useState } from "react";
import { DownloadIcon, FileIcon, MusicIcon } from "lucide-react";
import { CodeBlock, CodeBlockContent, CodeBlockLine } from "@/components/ui/code-block";
import { LazyMarkdown } from "@/components/lazy-markdown";
import { buttonVariants } from "@/components/ui/button";
import { RowButton } from "@/components/ui/row-button";
import { Skeleton } from "@/components/ui/skeleton";
import { useHighlightedCode } from "@/hooks/use-highlighted-code";
import { api } from "@/lib/api";
import { tableOf } from "@/lib/delimited";
import { formatBytes, langOf, TEXT_PREVIEW_CHARS, type FileRef } from "@/lib/file-meta";
import { cn } from "@/lib/utils";

/** Bottom padding that clears the home indicator on phones. */
const SAFE_BOTTOM = "pb-[max(1.25rem,env(safe-area-inset-bottom))]";

/** The artifact fetched once as text (capped); `null` skips the fetch. */
export function useArtifactText(
  id: string | null,
  /** A change refetches the same file (after a version is restored). */
  revision = 0,
): {
  text: string | null;
  failed: boolean;
  /** The file ran past the preview cap: only its start is shown. */
  cut: boolean;
} {
  const [state, setState] = useState({ text: null as string | null, failed: false, cut: false });
  useEffect(() => {
    setState({ text: null, failed: false, cut: false });
    if (id === null) return;
    const control = new AbortController();
    fetch(api.artifactUrl(id), { signal: control.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.text();
      })
      .then((body) =>
        setState({
          text: body.slice(0, TEXT_PREVIEW_CHARS),
          failed: false,
          cut: body.length > TEXT_PREVIEW_CHARS,
        }),
      )
      .catch(() => {
        if (!control.signal.aborted) setState({ text: null, failed: true, cut: false });
      });
    return () => control.abort();
  }, [id, revision]);
  return state;
}

export function FileDownload({
  file,
  variant = "outline",
}: {
  file: FileRef;
  variant?: "outline" | "default";
}) {
  return (
    <a
      href={api.artifactUrl(file.id, true)}
      aria-label={`Download ${file.name}`}
      className={buttonVariants({ variant, size: "lg" })}
    >
      <DownloadIcon data-icon="inline-start" /> Download
    </a>
  );
}

/** No inline view: say why, centred, with the download as the way forward. */
export function NoPreview({ file, children }: { file: FileRef; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-6 py-10 text-center",
        SAFE_BOTTOM,
      )}
    >
      <span className="bg-muted text-muted-foreground inline-flex size-14 items-center justify-center rounded-2xl">
        <FileIcon className="size-6" />
      </span>
      <p className="text-muted-foreground max-w-xs text-sm">{children}</p>
      <FileDownload file={file} variant="default" />
    </div>
  );
}

/** Loading skeleton, or the failure with the download beside it. */
export function FetchState({ file, failed }: { file: FileRef; failed: boolean }) {
  if (failed)
    return <NoPreview file={file}>Couldn’t load this file. Download it instead.</NoPreview>;
  return (
    <div role="status" aria-label="Loading the file" className="flex flex-col gap-3 px-4 py-4">
      <Skeleton className="h-5 w-1/2 rounded-full" />
      <Skeleton className="h-4 w-full rounded-full" />
      <Skeleton className="h-4 w-5/6 rounded-full" />
      <Skeleton className="h-4 w-2/3 rounded-full" />
    </div>
  );
}

/** "Showing the first 100 KB" when a text file ran past the cap. */
export function CutNote({ file }: { file: FileRef }) {
  return (
    <p className="text-muted-foreground border-border/60 shrink-0 border-b px-4 py-2 text-xs">
      Showing the first {formatBytes(TEXT_PREVIEW_CHARS)}
      {file.bytes !== undefined ? ` of ${formatBytes(file.bytes)}` : ""}. Download for the whole
      file.
    </p>
  );
}

/** Markdown as a document: a comfortable measure, centred when there is room. */
export function MarkdownView({ text }: { text: string }) {
  return (
    <div
      className={cn(
        "scrollbar-thin min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-4 sm:px-6 sm:pt-6",
        SAFE_BOTTOM,
      )}
    >
      {/* ```mermaid fences draw through the shared Diagram (lazy Pele, sanitized SVG). */}
      <article className="prose chat-prose md-doc dark:prose-invert mx-auto max-w-[72ch]">
        <LazyMarkdown text={text} />
      </article>
    </div>
  );
}

/** Text and code: numbered lines, highlighted when the language is bundled. */
export function CodeView({ text, name, wrap }: { text: string; name: string; wrap: boolean }) {
  const lines = useHighlightedCode(text, langOf(name));
  return (
    <CodeBlock className="min-h-0 flex-1 rounded-none border-0 bg-transparent dark:bg-transparent">
      <CodeBlockContent
        wrap={wrap}
        lineNumbers
        aria-label={`Contents of ${name}`}
        className={cn("scrollbar-thin flex-1 overscroll-contain", SAFE_BOTTOM)}
      >
        {lines.map((line, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: lines only append
          <CodeBlockLine key={index}>{line}</CodeBlockLine>
        ))}
      </CodeBlockContent>
    </CodeBlock>
  );
}

const TABLE_ROWS = 500;
const TABLE_COLS = 40;

/** CSV/TSV as a table: sticky header, row numbers, numbers right-aligned. */
export function TableView({ text, name, cut }: { text: string; name: string; cut: boolean }) {
  const table = useMemo(() => tableOf(text, name, TABLE_ROWS, TABLE_COLS), [text, name]);
  const cell = "border-border/50 max-w-[32ch] truncate border-b px-3 py-2 whitespace-nowrap";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="scrollbar-thin min-h-0 flex-1 overflow-auto overscroll-contain">
        <table className="min-w-full border-separate border-spacing-0 text-left text-sm">
          <thead>
            <tr>
              <th
                className={cn(
                  cell,
                  "bg-muted text-muted-foreground sticky top-0 z-10 w-0 text-right font-normal",
                )}
              >
                <span className="sr-only">Row</span>
              </th>
              {table.head.map((label, index) => (
                <th
                  key={index}
                  className={cn(
                    cell,
                    "bg-muted sticky top-0 z-10 font-medium",
                    table.numeric[index] === true && "text-right",
                  )}
                  title={label}
                >
                  {label === "" ? `Column ${index + 1}` : label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.body.map((row, rowIndex) => (
              <tr key={rowIndex} className="hover:bg-muted/40">
                <td className={cn(cell, "text-muted-foreground readout w-0 text-right text-xs")}>
                  {rowIndex + 1}
                </td>
                {Array.from({ length: table.width }, (_, index) => (
                  <td
                    key={index}
                    title={row[index] ?? ""}
                    className={cn(cell, table.numeric[index] === true && "tnum text-right")}
                  >
                    {row[index] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p
        className={cn(
          "text-muted-foreground readout border-border/60 shrink-0 border-t px-4 pt-2 text-xs",
          "pb-[max(0.5rem,env(safe-area-inset-bottom))]",
        )}
      >
        {table.body.length < table.totalRows || cut
          ? `First ${table.body.length} of ${table.totalRows}${cut ? "+" : ""} rows`
          : `${table.totalRows} rows`}
        {` · ${table.width} columns`}
      </p>
    </div>
  );
}

/** An image fitted to the space; fullscreen zooms to actual size on a click. */
export function ImageView({
  file,
  fullscreen,
  onOpen,
}: {
  file: FileRef;
  fullscreen: boolean;
  /** Inline: a click opens fullscreen. */
  onOpen: () => void;
}) {
  const [actual, setActual] = useState(false);
  const zoomed = fullscreen && actual;
  return (
    <div
      className={cn(
        "bg-muted/30 flex min-h-0 flex-1 overflow-auto overscroll-contain",
        !zoomed && "items-center justify-center p-4",
      )}
    >
      <RowButton
        aria-label={
          fullscreen
            ? actual
              ? "Fit to screen"
              : "Show actual size"
            : `Open ${file.name} fullscreen`
        }
        onClick={() => (fullscreen ? setActual((value) => !value) : onOpen())}
        className={cn(
          "rounded-lg",
          zoomed ? "m-auto cursor-zoom-out" : "flex max-h-full max-w-full cursor-zoom-in",
        )}
      >
        <img
          src={api.artifactUrl(file.id)}
          alt={file.name}
          className={cn(
            "rounded-lg",
            zoomed ? "max-w-none" : "max-h-full max-w-full object-contain",
          )}
        />
      </RowButton>
    </div>
  );
}

export function PdfView({ file }: { file: FileRef }) {
  return (
    <iframe
      src={api.artifactUrl(file.id)}
      title={file.name}
      className="min-h-0 w-full flex-1 border-0 bg-white"
    />
  );
}

export function VideoView({ file }: { file: FileRef }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-black">
      {/* biome-ignore lint/a11y/useMediaCaption: owner files carry no captions */}
      <video controls src={api.artifactUrl(file.id)} className="max-h-full max-w-full" />
    </div>
  );
}

export function AudioView({ file }: { file: FileRef }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 px-6 py-10">
      <span className="bg-muted text-muted-foreground inline-flex size-16 items-center justify-center rounded-2xl">
        <MusicIcon className="size-7" />
      </span>
      <p className="max-w-full truncate text-sm font-medium">{file.name}</p>
      {/* biome-ignore lint/a11y/useMediaCaption: owner files carry no captions */}
      <audio controls src={api.artifactUrl(file.id)} className="w-full max-w-md" />
    </div>
  );
}
