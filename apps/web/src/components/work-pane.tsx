/**
 * The work pane: a task's steps and result, a file, a bot's memory or the
 * Needs you list, shown beside the chat. Desktop (≥1024px) gets a floating
 * panel to the right of whatever screen is open; narrower screens get the
 * same content as a full-height sheet. Back walks the short trail of what was
 * opened from inside the pane; Close (or Escape) clears it.
 */
import { ChevronLeftIcon, XIcon } from "lucide-react";
import { useEffect, type ElementType } from "react";
import { MemoryContent } from "@/components/memory/memory-panel";
import { FileDownload, FilePreviewBody, fileSubtitle } from "@/components/file-preview";
import { NeedsList } from "@/components/needs-list";
import { TaskWork } from "@/components/task-activity";
import { fullTitle } from "@/components/task-sheet/sheet-header";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useApp } from "@/lib/app-state";
import { useMedia, WIDE } from "@/lib/use-media";
import { InWorkPane, useWorkPane } from "@/lib/work-pane";
import type { WorkItem } from "@/lib/work-stack";

const SHEET =
  "flex flex-col overflow-hidden p-0 pt-4 sm:p-0 sm:pt-4 h-[calc(100dvh-max(0.75rem,env(safe-area-inset-top)))] max-h-none sm:h-[85dvh]";

function titleOf(item: WorkItem): { title: string; subtitle: string | null } {
  switch (item.kind) {
    case "task":
      return { title: fullTitle(item.task), subtitle: "Background task" };
    case "file":
      return { title: item.file.name, subtitle: fileSubtitle(item.file) };
    case "memory":
      return { title: `What ${item.name} remembers`, subtitle: "Memory" };
    case "needs":
      return { title: "Needs you", subtitle: null };
  }
}

function Body({ item }: { item: WorkItem }) {
  const { tasks } = useApp();
  switch (item.kind) {
    case "task": {
      // The pane outlives the chat that opened it, so read the polled copy.
      const fresh = tasks.find((row) => row.id === item.task.id) ?? item.task;
      return <TaskWork task={fresh} />;
    }
    case "file":
      return (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-3 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
          <div className="mb-3 flex justify-end">
            <FileDownload file={item.file} />
          </div>
          <FilePreviewBody file={item.file} />
        </div>
      );
    case "memory":
      return (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-1 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
          <MemoryContent
            key={item.profileId}
            profileId={item.profileId}
            name={item.name}
            initialQuery={item.query}
          />
        </div>
      );
    case "needs":
      return (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pt-3 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
          <NeedsList />
        </div>
      );
  }
}

function Frame({ item, Title }: { item: WorkItem; Title: ElementType }) {
  const pane = useWorkPane();
  const { title, subtitle } = titleOf(item);
  return (
    <InWorkPane.Provider value>
      <div className="flex items-start gap-1 px-2 pb-2">
        {pane?.canBack === true ? (
          <Button variant="ghost" size="icon-lg" aria-label="Back" onClick={pane.back}>
            <ChevronLeftIcon />
          </Button>
        ) : (
          <span className="w-2 shrink-0" />
        )}
        <div className="flex min-w-0 flex-1 flex-col pt-1.5">
          {subtitle !== null && (
            <span className="text-muted-foreground truncate text-xs">{subtitle}</span>
          )}
          <Title className="line-clamp-2 text-base leading-snug font-semibold break-words outline-none">
            {title}
          </Title>
        </div>
        <Button variant="ghost" size="icon-lg" aria-label="Close" onClick={pane?.close}>
          <XIcon />
        </Button>
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <Body item={item} />
      </div>
    </InWorkPane.Provider>
  );
}

const PlainTitle = (props: React.ComponentProps<"h2">) => <h2 {...props} />;
const SheetTitle = (props: React.ComponentProps<"h2">) => <DialogTitle {...props} />;

export function WorkPane() {
  const pane = useWorkPane();
  const wide = useMedia(WIDE);
  const item = pane?.item ?? null;

  // Escape closes the side panel (the sheet handles its own).
  useEffect(() => {
    if (!wide || item === null) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !event.defaultPrevented) pane?.close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [wide, item, pane]);

  if (pane === null || item === null) return null;
  if (wide)
    return (
      <aside
        aria-label="Work"
        className="bg-card border-border/70 animate-in fade-in slide-in-from-right-3 my-3 mr-3 flex w-[clamp(20rem,34vw,30rem)] shrink-0 flex-col overflow-hidden rounded-3xl border pt-3 shadow-sm duration-200 motion-reduce:animate-none"
      >
        <Frame item={item} Title={PlainTitle} />
      </aside>
    );
  return (
    <Dialog open onOpenChange={(open) => !open && pane.close()}>
      <DialogContent showCloseButton={false} className={SHEET}>
        <Frame item={item} Title={SheetTitle} />
      </DialogContent>
    </Dialog>
  );
}
