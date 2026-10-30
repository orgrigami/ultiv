/**
 * The shared file preview: a dialog (bottom sheet on phones) that shows a
 * bot-shared file inline when it is safe to — images, text/code, PDF, audio,
 * video — and otherwise says why not, with the download one tap away. Every
 * surface (chat cards, reply links, the Files tab, the task sheet) opens this.
 */
import { useEffect, useState } from "react";
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
  <EmptyState>“{name}” is too large to preview — download it instead.</EmptyState>
);

/** Text and code: fetched once, capped, highlighted when we bundle the language. */
function TextPreview({ file }: { file: FileRef }) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const control = new AbortController();
    fetch(api.artifactUrl(file.id), { signal: control.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.text();
      })
      .then((body) => setText(body.slice(0, TEXT_PREVIEW_CHARS)))
      .catch(() => {
        if (!control.signal.aborted) setFailed(true);
      });
    return () => control.abort();
  }, [file.id]);
  const lines = useHighlightedCode(text ?? "", langOf(file.name));
  if (text === null) {
    return failed ? (
      <EmptyState>Couldn’t load this file — download it instead.</EmptyState>
    ) : (
      <div className="text-muted-foreground flex items-center justify-center gap-2 py-8 text-sm">
        <Spinner /> Loading…
      </div>
    );
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
        ? "This file type can’t be previewed safely — download it instead."
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
          ) : (
            <InlineBody file={file} kind={kind} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
