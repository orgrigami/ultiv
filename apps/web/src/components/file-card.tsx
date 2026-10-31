/**
 * The file card: one row for a bot-shared file, everywhere it appears — chat
 * transcript (artifact_write steps, bot reply links), the Files tab, the task
 * work. Preview opens the work pane (a dialog outside the app shell); Download rides the server's ?dl=1
 * content disposition, so the filename survives the save.
 */
import { useEffect, useState, type ComponentType } from "react";
import {
  DownloadIcon,
  EyeIcon,
  FileIcon,
  FileTextIcon,
  FileTypeIcon,
  ImageIcon,
  MusicIcon,
  VideoIcon,
  TableIcon,
} from "lucide-react";
import { FilePreviewDialog } from "@/components/file-preview";
import { api } from "@/lib/api";
import { useOpenWork } from "@/lib/work-pane";
import {
  formatBytes,
  kindLabel,
  previewKindOf,
  type FileRef,
  type PreviewKind,
} from "@/lib/file-meta";

const ICONS: Record<PreviewKind, ComponentType<{ className?: string }>> = {
  image: ImageIcon,
  text: FileTextIcon,
  markdown: FileTextIcon,
  csv: TableIcon,
  pdf: FileTypeIcon,
  audio: MusicIcon,
  video: VideoIcon,
  none: FileIcon,
  blocked: FileIcon,
};

/** Icon-button style shared by the card's Preview and Download actions. */
const ACTION =
  "text-muted-foreground hover:text-foreground hover:bg-muted focus-visible:ring-ring/50 " +
  "inline-flex size-8 shrink-0 items-center justify-center rounded-md outline-none " +
  "focus-visible:ring-3 pointer-coarse:size-11";

interface Info {
  readonly file: FileRef;
  /** Meta fetch failed: the file is gone or not ours — preview stays hidden. */
  readonly missing: boolean;
}

/** Fill unknown mime/bytes from /meta once; 404/403 mark the card missing. */
function useFileInfo(file: FileRef): Info {
  const [info, setInfo] = useState<Info>({ file, missing: false });
  useEffect(() => {
    if (file.mime !== undefined && file.bytes !== undefined) return;
    let live = true;
    api.artifactMeta(file.id).then(
      (row) => {
        if (live) setInfo({ file: { ...file, mime: row.mime, bytes: row.bytes }, missing: false });
      },
      () => {
        if (live) setInfo({ file, missing: true });
        return undefined;
      },
    );
    return () => {
      live = false;
    };
  }, [file]);
  return info;
}

export function FileCard({ file, className }: { file: FileRef; className?: string }) {
  const { file: known, missing } = useFileInfo(file);
  const [target, setTarget] = useState<FileRef | null>(null);
  const openWork = useOpenWork();
  const preview = (): void =>
    openWork === null ? setTarget(known) : openWork({ kind: "file", file: known });
  const kind = previewKindOf(known.mime, known.name);
  const Icon = ICONS[kind];
  return (
    <span
      className={
        "flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-sm " + (className ?? "")
      }
    >
      <Icon className="text-muted-foreground size-4 shrink-0" aria-hidden />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate" title={known.name}>
          {known.name}
        </span>
        <span className="text-muted-foreground text-xs">
          {missing
            ? "File unavailable"
            : known.bytes === undefined
              ? kindLabel(known.mime, known.name)
              : `${kindLabel(known.mime, known.name)} · ${formatBytes(known.bytes)}`}
        </span>
      </span>
      {!missing && (
        <button
          type="button"
          aria-label={`Preview ${known.name}`}
          onClick={preview}
          className={ACTION}
        >
          <EyeIcon className="size-4" />
        </button>
      )}
      <a
        href={api.artifactUrl(known.id, true)}
        aria-label={`Download ${known.name}`}
        className={ACTION}
      >
        <DownloadIcon className="size-4" />
      </a>
      {target !== null && <FilePreviewDialog file={target} onClose={() => setTarget(null)} />}
    </span>
  );
}
