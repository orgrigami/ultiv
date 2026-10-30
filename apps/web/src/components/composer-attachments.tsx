/**
 * The composer's attachments: the "+" menu (add images, attach a file, then
 * the starter prompts), the staged chips above the box, and the staging
 * hook. Files upload when the message sends — an abandoned draft leaves no
 * orphans in the workspace.
 */
import { useEffect, useRef, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { FileTextIcon, ImagePlusIcon, PaperclipIcon, PlusIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/file-meta";
import { isImageMime, MAX_UPLOAD_BYTES } from "@/lib/attachments";

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

const menuItem = "h-auto min-h-9 justify-start gap-2 py-2 text-left whitespace-normal font-normal";

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
  const files = useRef<HTMLInputElement>(null);
  const pick =
    (input: React.RefObject<HTMLInputElement | null>) =>
    (event: React.MouseEvent): void => {
      event.preventDefault();
      input.current?.click();
    };
  return (
    <Popover.Root>
      <Popover.Trigger
        disabled={disabled}
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-lg"
            className="shrink-0 rounded-full bg-muted/70"
            aria-label="Add images, files, or quick prompts"
          >
            <PlusIcon />
          </Button>
        }
      />
      <Popover.Portal>
        <Popover.Positioner side="top" align="start" sideOffset={8} className="z-50">
          <Popover.Popup className="bg-popover text-popover-foreground flex w-72 max-w-[calc(100vw-1.5rem)] flex-col rounded-xl border p-1 shadow-lg outline-none">
            <Popover.Close
              render={
                <Button variant="ghost" className={menuItem} onClick={pick(images)}>
                  <ImagePlusIcon /> Add images
                </Button>
              }
            />
            <Popover.Close
              render={
                <Button variant="ghost" className={menuItem} onClick={pick(files)}>
                  <PaperclipIcon /> Attach file
                </Button>
              }
            />
            <div role="separator" className="bg-border my-1 h-px" />
            {SUGGESTIONS.map((text) => (
              <Popover.Close
                key={text}
                render={
                  <Button
                    variant="ghost"
                    className="h-auto justify-start py-2 text-left whitespace-normal"
                  />
                }
                onClick={() => onDraft(text)}
              >
                {text}
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
            className="shrink-0 rounded-full"
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
