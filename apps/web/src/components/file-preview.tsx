/**
 * The shared file preview: a dialog (bottom sheet on phones) that shows a
 * bot-shared file inline when it is safe to — images, text/code, PDF, audio,
 * video — and otherwise says why not, with the download one tap away. Every
 * surface (chat cards, reply links, the Files tab, the task sheet) opens this.
 */
import { useEffect, useMemo, useState } from "react";
import { DownloadIcon } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
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
import { Spinner } from "@/components/ui/spinner";
import { buttonVariants } from "@/components/ui/button";
import { useHighlightedCode } from "@/hooks/use-highlighted-code";
import { api } from "@/lib/api";
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
    <div className="text-muted-foreground flex items-center justify-center gap-2 py-8 text-sm">
      <Spinner /> Loading…
    </div>
  );
}

/** Markdown: rendered as prose by default, the source one toggle away. */
function MarkdownPreview({ file }: { file: FileRef }) {
  const { text, failed } = useArtifactText(file.id);
  const [source, setSource] = useState(false);
  if (text === null) return <FetchState failed={failed} />;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setSource((value) => !value)}
          className="readout text-muted-foreground hover:text-foreground rounded-md border px-2 py-1 outline-none"
        >
          {source ? "Rendered" : "Source"}
        </button>
      </div>
      {source ? (
        <TextPreview file={file} text={text} />
      ) : (
        <div className="prose prose-sm dark:prose-invert max-h-[55dvh] max-w-none overflow-y-auto rounded-lg border p-4">
          <LazyMarkdown text={text} />
        </div>
      )}
    </div>
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
    const delimiter = file.name.toLowerCase().endsWith(".tsv") ? "\t" : ",";
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
                    className="overline-plate border-border border-b px-2.5 py-1.5 whitespace-nowrap"
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
function TextPreview({ file, text: given }: { file: FileRef; text?: string | undefined }) {
  const fetched = useArtifactText(file.id);
  const text = given ?? fetched.text;
  const failed = given === undefined && fetched.failed;
  const lines = useHighlightedCode(text ?? "", langOf(file.name));
  if (text === null) {
    return <FetchState failed={failed} />;
  }
  return (
    <CodeBlock size="sm" className="max-h-[55dvh] overflow-y-auto">
      <CodeBlockHeader>
        <CodeBlockTitle>{langOf(file.name) === "" ? "text" : langOf(file.name)}</CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton value={text} />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent>
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

export function FilePreviewDialog({ file, onClose }: { file: FileRef; onClose: () => void }) {
  const kind = previewKindOf(file.mime, file.name);
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
            <p className="text-muted-foreground mt-0.5 text-xs">
              {kindLabel(file.mime, file.name)}
              {file.bytes === undefined ? "" : ` · ${formatBytes(file.bytes)}`}
            </p>
          </div>
          <a
            href={api.artifactUrl(file.id, true)}
            aria-label={`Download ${file.name}`}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            <DownloadIcon data-icon="inline-start" /> Download
          </a>
        </div>
        <div className="mt-4">
          {kind === "text" ? (
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
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
