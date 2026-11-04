/**
 * The shared file preview. Every surface (chat cards, reply links, the Files
 * tab, the task sheet) opens it — in the work pane, its phone sheet, or a
 * dialog outside the app shell. One slim toolbar (Preview/Source, wrap,
 * copy, download, fullscreen) sits over a body that fills the space; the
 * bodies per kind live in file-views.tsx. Fullscreen is its own dialog
 * over everything, so it works from the phone sheet too.
 */
import { useState } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { DownloadIcon, Maximize2Icon, Minimize2Icon, WrapTextIcon } from "lucide-react";
import { Dialog, DialogContent, DialogTitle, TALL_SHEET } from "@/components/ui/dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { CodeBlockCopyButton } from "@/components/ui/code-block";
import {
  AudioView,
  CodeView,
  CutNote,
  FetchState,
  ImageView,
  MarkdownView,
  NoPreview,
  PdfView,
  TableView,
  useArtifactText,
  VideoView,
} from "@/components/file-views";
import { api } from "@/lib/api";
import {
  formatBytes,
  kindLabel,
  MEDIA_PREVIEW_BYTES,
  previewKindOf,
  type FileRef,
  type PreviewKind,
} from "@/lib/file-meta";

export { FileDownload } from "@/components/file-views";

type View = "rendered" | "source";

/** Kinds read as text; the ones with a rendered view name it. */
const TEXTUAL: ReadonlySet<PreviewKind> = new Set(["text", "markdown", "csv"]);
const RENDERED_LABEL: Partial<Record<PreviewKind, string>> = {
  markdown: "Preview",
  csv: "Table",
};
/** Kinds with nothing worth enlarging. */
const NO_FULLSCREEN: ReadonlySet<PreviewKind> = new Set(["audio", "none", "blocked"]);

const WRAP_KEY = "spriessen.preview.wrap";

/** Soft-wrap for code, remembered on this device; on unless turned off. */
function useWrap(): [boolean, () => void] {
  const [wrap, setWrap] = useState(() => {
    try {
      return globalThis.localStorage?.getItem(WRAP_KEY) !== "off";
    } catch {
      return true;
    }
  });
  const toggle = (): void =>
    setWrap((value) => {
      try {
        globalThis.localStorage?.setItem(WRAP_KEY, value ? "off" : "on");
      } catch {
        // Private mode: the choice lasts for this view only.
      }
      return !value;
    });
  return [wrap, toggle];
}

/** "Text file · 2 KB" under a file's name. */
export const fileSubtitle = (file: FileRef): string =>
  `${kindLabel(file.mime, file.name)}${file.bytes === undefined ? "" : ` · ${formatBytes(file.bytes)}`}`;

interface ViewerState {
  readonly file: FileRef;
  readonly kind: PreviewKind;
  readonly text: { text: string | null; failed: boolean; cut: boolean };
  readonly view: View;
  readonly setView: (view: View) => void;
  readonly wrap: boolean;
  readonly toggleWrap: () => void;
  readonly openFull: () => void;
}

function ViewSwitch({
  label,
  view,
  onChange,
}: {
  label: string;
  view: View;
  onChange: (view: View) => void;
}) {
  return (
    <div
      role="group"
      aria-label="View"
      className="bg-muted inline-flex shrink-0 rounded-full p-0.5"
    >
      {(["rendered", "source"] as const).map((id) => (
        <Button
          key={id}
          variant="segment"
          size="sm"
          pill
          aria-pressed={view === id}
          onClick={() => onChange(id)}
        >
          {id === "rendered" ? label : "Source"}
        </Button>
      ))}
    </div>
  );
}

function Toolbar({ state, fullscreen }: { state: ViewerState; fullscreen: boolean }) {
  const { file, kind, text, view } = state;
  const rendered = RENDERED_LABEL[kind];
  const showsCode = kind === "text" || (rendered !== undefined && view === "source");
  return (
    <div className="border-border/60 flex shrink-0 items-center gap-1 border-b px-3 py-1.5 sm:px-4">
      {rendered !== undefined && text.text !== null && (
        <ViewSwitch label={rendered} view={view} onChange={state.setView} />
      )}
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        {showsCode && text.text !== null && (
          <Button
            variant="toggle"
            size="icon"
            aria-label="Wrap long lines"
            title="Wrap long lines"
            aria-pressed={state.wrap}
            onClick={state.toggleWrap}
          >
            <WrapTextIcon />
          </Button>
        )}
        {TEXTUAL.has(kind) && text.text !== null && (
          <CodeBlockCopyButton value={text.text} size="icon" title="Copy" />
        )}
        <a
          href={api.artifactUrl(file.id, true)}
          aria-label={`Download ${file.name}`}
          title="Download"
          className={buttonVariants({ variant: "ghost", size: "icon" })}
        >
          <DownloadIcon />
        </a>
        {!fullscreen && !NO_FULLSCREEN.has(kind) && (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Fullscreen"
            title="Fullscreen"
            onClick={state.openFull}
          >
            <Maximize2Icon />
          </Button>
        )}
      </div>
    </div>
  );
}

const oversized = (file: FileRef): boolean =>
  file.bytes !== undefined && file.bytes > MEDIA_PREVIEW_BYTES;

function Content({ state, fullscreen }: { state: ViewerState; fullscreen: boolean }) {
  const { file, kind, text, view, wrap } = state;
  if (TEXTUAL.has(kind)) {
    if (text.text === null) return <FetchState file={file} failed={text.failed} />;
    const body =
      kind === "markdown" && view === "rendered" ? (
        <MarkdownView text={text.text} />
      ) : kind === "csv" && view === "rendered" ? (
        <TableView text={text.text} name={file.name} cut={text.cut} />
      ) : (
        <CodeView text={text.text} name={file.name} wrap={wrap} />
      );
    return (
      <>
        {text.cut && !(kind === "csv" && view === "rendered") && <CutNote file={file} />}
        {body}
      </>
    );
  }
  if (kind === "pdf") return <PdfView file={file} />;
  if ((kind === "image" || kind === "video" || kind === "audio") && oversized(file)) {
    return (
      <NoPreview file={file}>“{file.name}” is too large to preview. Download it instead.</NoPreview>
    );
  }
  if (kind === "image")
    return <ImageView file={file} fullscreen={fullscreen} onOpen={state.openFull} />;
  if (kind === "video") return <VideoView file={file} />;
  if (kind === "audio") return <AudioView file={file} />;
  return (
    <NoPreview file={file}>
      {kind === "blocked"
        ? "This file type can’t be previewed safely. Download it instead."
        : "There’s no preview for this kind of file. Download it to open it."}
    </NoPreview>
  );
}

/** Fullscreen: the whole viewport, above any sheet; Escape or the button returns. */
function Fullscreen({
  state,
  open,
  onOpenChange,
}: {
  state: ViewerState;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Popup
          aria-describedby={undefined}
          className="bg-background text-foreground fixed inset-0 z-[60] flex flex-col pt-[env(safe-area-inset-top)] transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none"
        >
          <div className="flex shrink-0 items-center gap-2 py-1.5 pr-1.5 pl-4 sm:pr-2.5 sm:pl-6">
            <div className="flex min-w-0 flex-1 flex-col">
              <DialogPrimitive.Title className="truncate text-base leading-snug font-semibold">
                {state.file.name}
              </DialogPrimitive.Title>
              <span className="text-muted-foreground truncate text-xs">
                {fileSubtitle(state.file)}
              </span>
            </div>
            <DialogPrimitive.Close
              render={
                <Button
                  variant="ghost"
                  size="icon-lg"
                  aria-label="Exit fullscreen"
                  title="Exit fullscreen (Esc)"
                >
                  <Minimize2Icon />
                </Button>
              }
            />
          </div>
          <Toolbar state={state} fullscreen />
          <div className="relative flex min-h-0 flex-1 flex-col">
            <Content state={state} fullscreen />
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** The preview itself (no title): the work pane and the dialog both show this. */
export function FilePreviewBody({ file }: { file: FileRef }) {
  const kind = previewKindOf(file.mime, file.name);
  const text = useArtifactText(TEXTUAL.has(kind) ? file.id : null);
  const [view, setView] = useState<View>("rendered");
  const [wrap, toggleWrap] = useWrap();
  const [full, setFull] = useState(false);
  const state: ViewerState = {
    file,
    kind,
    text,
    view,
    setView,
    wrap,
    toggleWrap,
    openFull: () => setFull(true),
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Toolbar state={state} fullscreen={false} />
      {/* The inline body steps aside while fullscreen shows it (one player, one fetch of media). */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {!full && <Content state={state} fullscreen={false} />}
      </div>
      <Fullscreen state={state} open={full} onOpenChange={setFull} />
    </div>
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
      <DialogContent className={TALL_SHEET}>
        <div className="flex shrink-0 flex-col px-5 pb-2 sm:px-6">
          <DialogTitle className="truncate pr-10 text-base font-semibold">{file.name}</DialogTitle>
          <p className="text-muted-foreground text-xs">{fileSubtitle(file)}</p>
        </div>
        <FilePreviewBody file={file} />
      </DialogContent>
    </Dialog>
  );
}
