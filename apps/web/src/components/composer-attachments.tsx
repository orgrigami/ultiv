/**
 * The composer's attachments: the "+" menu (add images, attach a file, then
 * the starter prompts), the staged chips above the box, and the staging
 * hook. Files upload when the message sends — an abandoned draft leaves no
 * orphans in the workspace.
 */
import { useEffect, useRef, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import {
  FileTextIcon,
  MessageSquareTextIcon,
  ImagePlusIcon,
  PaperclipIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  PopoverSheetBackdrop,
  SheetHeading,
  SheetSeparator,
  sheetPopup,
  sheetPositioner,
  sheetRow,
  usePhoneSheet,
} from "@/components/ui/menu-sheet";
import { formatBytes } from "@/lib/file-meta";
import { isImageMime, MAX_UPLOAD_BYTES } from "@/lib/attachments";
import { cn } from "@/lib/utils";

/** Starter prompts: the "+" menu and the empty chat both offer them. */
export const SUGGESTIONS = [
  "What can you do for me?",
  "What do you remember about me?",
  "Help me plan my day",
  "Remind me tomorrow at 9am to check my email",
] as const;

/** One staged file: the raw File plus its object URL (images only, for the chip). */
export interface Staged {
  readonly key: string;
  readonly file: File;
  readonly url: string | undefined;
}

const MAX_STAGED = 8;

const stagedKey = (): string => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** The composer's staged files: add (capped), remove, and clear-what-was-sent. */
export function useStagedAttachments() {
  const [staged, setStaged] = useState<Staged[]>([]);
  const latest = useRef<Staged[]>([]);
  useEffect(() => {
    latest.current = staged;
  }, [staged]);
  // Object URLs live exactly as long as their chips do.
  useEffect(
    () => () => {
      for (const item of latest.current) {
        if (item.url !== undefined) URL.revokeObjectURL(item.url);
      }
    },
    [],
  );
  const add = (files: Iterable<File>): void => {
    setStaged((current) => {
      const room = MAX_STAGED - current.length;
      const next = [...current];
      for (const file of Array.from(files).slice(0, Math.max(0, room))) {
        if (file.size > MAX_UPLOAD_BYTES) continue;
        next.push({
          key: stagedKey(),
          file,
          url: isImageMime(file.type) ? URL.createObjectURL(file) : undefined,
        });
      }
      return next;
    });
  };
  const remove = (key: string): void =>
    setStaged((current) => {
      const found = current.find((item) => item.key === key);
      if (found?.url !== undefined) URL.revokeObjectURL(found.url);
      return current.filter((item) => item.key !== key);
    });
  const clearKeys = (keys: ReadonlySet<string>): void =>
    setStaged((current) => {
      for (const item of current) {
        if (keys.has(item.key) && item.url !== undefined) URL.revokeObjectURL(item.url);
      }
      return current.filter((item) => !keys.has(item.key));
    });
  return { staged, add, remove, clearKeys };
}

/** The round "+": a small menu — images, any file, then the starter prompts. */
export function PlusMenu({
  disabled,
  onAdd,
  onDraft,
}: {
  disabled: boolean;
  onAdd: (files: FileList | File[]) => void;
  onDraft: (text: string) => void;
}) {
  const images = useRef<HTMLInputElement>(null);
  const phone = usePhoneSheet();
  const files = useRef<HTMLInputElement>(null);
  const pick =
    (input: React.RefObject<HTMLInputElement | null>) =>
    (event: React.MouseEvent): void => {
      event.preventDefault();
      input.current?.click();
    };
  return (
    <Popover.Root modal={phone}>
      <Popover.Trigger
        disabled={disabled}
        render={
          <Button
            type="button"
            variant="muted"
            size="composer"
            pill
            className="shrink-0"
            aria-label="Add images, files, or quick prompts"
          >
            <PlusIcon />
          </Button>
        }
      />
      <Popover.Portal>
        <PopoverSheetBackdrop />
        <Popover.Positioner side="top" align="start" sideOffset={8} {...sheetPositioner}>
          <Popover.Popup className={cn(sheetPopup, "w-72")}>
            <Popover.Title render={<SheetHeading>Add to your message</SheetHeading>} />
            <Popover.Close className={sheetRow} onClick={pick(images)}>
              <ImagePlusIcon className="text-muted-foreground" /> Add images
            </Popover.Close>
            <Popover.Close className={sheetRow} onClick={pick(files)}>
              <PaperclipIcon className="text-muted-foreground" /> Attach file
            </Popover.Close>
            <SheetSeparator />
            <SheetHeading always>Start with</SheetHeading>
            {SUGGESTIONS.map((text) => (
              <Popover.Close key={text} className={sheetRow} onClick={() => onDraft(text)}>
                <MessageSquareTextIcon className="text-muted-foreground" />
                <span className="min-w-0 flex-1">{text}</span>
              </Popover.Close>
            ))}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
      <input
        ref={images}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(event) => {
          onAdd(event.target.files ?? []);
          event.target.value = "";
        }}
      />
      <input
        ref={files}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          onAdd(event.target.files ?? []);
          event.target.value = "";
        }}
      />
    </Popover.Root>
  );
}

/** The staged files above the box: thumbnails for images, icon + name + size otherwise. */
export function StagedChips({
  staged,
  onRemove,
}: {
  staged: readonly Staged[];
  onRemove: (key: string) => void;
}) {
  if (staged.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {staged.map((item) => (
        <span
          key={item.key}
          className="bg-background/70 border-border flex items-center gap-1.5 rounded-lg border py-1 pr-1 pl-2 text-xs shadow-sm backdrop-blur-md"
        >
          {item.url !== undefined ? (
            <img
              src={item.url}
              alt={item.file.name}
              className="border-border size-8 rounded border object-cover"
            />
          ) : (
            <FileTextIcon className="text-muted-foreground size-4 shrink-0" />
          )}
          <span className="max-w-40 truncate">{item.file.name}</span>
          <span className="text-muted-foreground readout">{formatBytes(item.file.size)}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            pill
            className="shrink-0"
            aria-label={`Remove ${item.file.name}`}
            title="Remove"
            onClick={() => onRemove(item.key)}
          >
            <XIcon />
          </Button>
        </span>
      ))}
    </div>
  );
}
