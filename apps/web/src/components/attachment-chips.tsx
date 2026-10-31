/**
 * The files an owner attached to an input, rendered inside the message
 * bubble: images show a thumbnail that opens the file in the work pane, other
 * files render a standard file card. Refs only — bytes live behind
 * /api/artifacts/:id, never in the transcript state.
 */
import { useState } from "react";
import type { AttachmentRef } from "@ultiv/contracts";
import { api } from "@/lib/api";
import { useOpenWork } from "@/lib/work-pane";
import { FileCard } from "./file-card.tsx";
import { FilePreviewDialog } from "./file-preview.tsx";

/** Thumbnails for images (open the preview), file cards for everything else. */
export function AttachmentChips({ attachments }: { attachments: readonly AttachmentRef[] }) {
  const [open, setOpen] = useState<AttachmentRef | undefined>(undefined);
  const openWork = useOpenWork();
  const preview = (ref: AttachmentRef): void => {
    if (openWork === null) setOpen(ref);
    else
      openWork({
        kind: "file",
        file: {
          id: ref.id,
          name: ref.name,
          mime: ref.mime,
          ...(ref.bytes !== undefined ? { bytes: ref.bytes } : {}),
        },
      });
  };
  return (
    <span className="mt-1 flex flex-wrap items-end gap-1.5">
      {attachments.map((ref) =>
        ref.mime.startsWith("image/") ? (
          <button
            key={ref.id}
            type="button"
            className="focus-visible:ring-ring/50 block overflow-hidden rounded-lg border border-border/70 focus-visible:ring-2 focus-visible:outline-none"
            onClick={() => preview(ref)}
            aria-label={`Open ${ref.name}`}
            title={ref.name}
          >
            <img
              src={api.artifactUrl(ref.id)}
              alt={ref.name}
              className="size-20 object-cover"
              loading="lazy"
            />
          </button>
        ) : (
          <FileCard key={ref.id} file={ref} className="w-56" />
        ),
      )}
      {open !== undefined && (
        <FilePreviewDialog
          file={{
            id: open.id,
            name: open.name,
            mime: open.mime,
            ...(open.bytes !== undefined ? { bytes: open.bytes } : {}),
          }}
          onClose={() => setOpen(undefined)}
        />
      )}
    </span>
  );
}
