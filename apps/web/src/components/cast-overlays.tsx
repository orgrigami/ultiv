/**
 * What the bot's page waits on, shown over the live picture: a page dialog
 * (alert, confirm, prompt — the page is frozen until it is answered) and a
 * file chooser (the page asked for a file). While driving, the owner answers
 * them here; while watching, they are named, never answered. Downloads the
 * page finished land in the bot's files and list under the picture.
 */
import { useRef, useState } from "react";
import { FileUpIcon, MessageSquareWarningIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FileCard } from "@/components/file-card";
import type { TakeoverCast } from "@/lib/takeover-cast";

/** 25 MB: the most a page gets from one upload. */
const UPLOAD_CAP = 25 * 1024 * 1024;

const card =
  "bg-popover text-popover-foreground absolute inset-x-3 bottom-3 z-10 flex flex-col gap-2 rounded-lg border p-3 text-sm shadow-md";

function DialogPrompt({ cast, drive }: { cast: TakeoverCast; drive: boolean }) {
  const dialog = cast.dialog;
  const [answer, setAnswer] = useState("");
  if (dialog === null) return null;
  const reply = (accept: boolean): void =>
    cast.send({ a: "dialog", accept, ...(dialog.type === "prompt" ? { text: answer } : {}) });
  return (
    <div className={card} role="alertdialog" aria-label="The page asks">
      <span className="flex items-start gap-2">
        <MessageSquareWarningIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" />
        <span className="min-w-0 break-words">{dialog.message || "The page shows a dialog."}</span>
      </span>
      {drive && dialog.type === "prompt" && (
        <Input
          aria-label="Your answer"
          defaultValue={dialog.default}
          onChange={(event) => setAnswer(event.target.value)}
        />
      )}
      {drive ? (
        <span className="flex justify-end gap-2">
          {dialog.type !== "alert" && (
            <Button variant="ghost" size="sm" onClick={() => reply(false)}>
              Cancel
            </Button>
          )}
          <Button size="sm" onClick={() => reply(true)}>
            OK
          </Button>
        </span>
      ) : (
        <span className="text-muted-foreground text-xs">The bot answers this one.</span>
      )}
    </div>
  );
}

function ChooserPrompt({ cast, drive }: { cast: TakeoverCast; drive: boolean }) {
  const input = useRef<HTMLInputElement | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  if (cast.chooser === null || cast.dialog !== null) return null;
  const pick = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return;
    if (file.size > UPLOAD_CAP) {
      setProblem(`${file.name} is larger than 25 MB.`);
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    let raw = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      raw += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    setProblem(null);
    cast.send({ a: "upload", name: file.name, data: btoa(raw) });
  };
  return (
    <div className={card} role="dialog" aria-label="The page asks for a file">
      <span className="flex items-center gap-2">
        <FileUpIcon className="text-muted-foreground size-4 shrink-0" />
        The page asks for a file.
      </span>
      {problem !== null && <span className="text-destructive text-xs">{problem}</span>}
      {drive ? (
        <span className="flex justify-end">
          <input
            ref={input}
            type="file"
            className="hidden"
            onChange={(event) => void pick(event.target.files?.[0])}
          />
          <Button size="sm" onClick={() => input.current?.click()}>
            Choose a file
          </Button>
        </span>
      ) : (
        <span className="text-muted-foreground text-xs">The bot gives it one of its files.</span>
      )}
    </div>
  );
}

/** Everything the page waits on, over the picture. */
export function CastWaits({ cast, drive }: { cast: TakeoverCast; drive: boolean }) {
  return (
    <>
      <DialogPrompt cast={cast} drive={drive} />
      <ChooserPrompt cast={cast} drive={drive} />
    </>
  );
}

/** Downloads the page finished during this view, now in the bot's files. */
export function SavedDownloads({ cast, botName }: { cast: TakeoverCast; botName: string }) {
  if (cast.saved.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-muted-foreground text-xs">Downloaded into {botName}'s files</span>
      {cast.saved.map((file) => (
        <FileCard key={file.id} file={{ id: file.id, name: file.name }} />
      ))}
    </div>
  );
}
