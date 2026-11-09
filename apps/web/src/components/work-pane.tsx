/**
 * The work dock: a task's steps and result, a file, a bot's memory, the
 * Needs you list, a room or the bots' browsers, shown beside the chat. Desktop (≥1024px) gets a
 * floating panel to the right of whatever screen is open; narrower screens
 * get the active tab as a full-height sheet. The dock holds several tabs at
 * once: the strip at its top switches between them, so a task, a file and
 * memory can all stay open beside one conversation. Back steps within the
 * active tab's trail; a strip tab's ✕ closes that tab; the header's ✕ (or
 * Escape) closes the active one, and the dock leaves when the last tab does.
 */
import { ChevronLeftIcon, XIcon } from "lucide-react";
import {
  BellDotIcon,
  BrainIcon,
  FileIcon,
  GlobeIcon,
  ListTodoIcon,
  MessagesSquareIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, type ElementType } from "react";
import { MemoryContent } from "@/components/memory/memory-panel";
import { FilePreviewBody, fileSubtitle } from "@/components/file-preview";
import { FileSourceById } from "@/components/file-source";
import { NeedsList } from "@/components/needs-list";
import { BrowsersPanel } from "@/components/browser-takeover-tab";
import { RoomTimeline } from "@/components/room-timeline";
import { TaskWork } from "@/components/task-activity";
import { fullTitle } from "@/components/task-sheet/sheet-header";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, TALL_SHEET } from "@/components/ui/dialog";
import { useApp } from "@/lib/app-state";
import { useMedia, WIDE } from "@/lib/use-media";
import { InWorkPane, useWorkPane, type WorkPaneState } from "@/lib/work-pane";
import type { WorkItem } from "@/lib/work-stack";

/** One small icon per kind, so a strip tab reads at a glance. */
const KIND_ICON: Record<WorkItem["kind"], LucideIcon> = {
  task: ListTodoIcon,
  file: FileIcon,
  memory: BrainIcon,
  needs: BellDotIcon,
  browsers: GlobeIcon,
  room: MessagesSquareIcon,
};

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
    case "browsers":
      return { title: "Browsers", subtitle: "Your bots' browsers, live" };
    case "room":
      return {
        title: item.title,
        subtitle: item.topic !== null ? `Bot talks · ${item.topic}` : "Bot talks",
      };
  }
}

/** The strip of open tabs above the frame: one pill per tab, in open order. */
function TabStrip({ pane }: { pane: WorkPaneState }) {
  return (
    <div
      aria-label="Open work"
      className="text-muted-foreground flex min-w-0 shrink-0 gap-1 overflow-x-auto px-2 pb-2"
    >
      {pane.tabs.map((tab) => {
        const active = tab.key === pane.activeKey;
        const Icon = KIND_ICON[tab.item.kind];
        const { title } = titleOf(tab.item);
        return (
          <div key={tab.key} className="flex shrink-0 items-center">
            <Button
              type="button"
              variant="toggle"
              size="sm"
              pill
              aria-pressed={active}
              title={title}
              onClick={() => pane.select(tab.key)}
            >
              <Icon className="size-3.5 shrink-0" />
              <span className="max-w-24 truncate sm:max-w-28">{title}</span>
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Close ${title}`}
              onClick={() => pane.closeTab(tab.key)}
            >
              <XIcon />
            </Button>
          </div>
        );
      })}
    </div>
  );
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
      // The preview owns its toolbar and its one scroll area; its chat sits above it.
      return (
        <>
          <FileSourceById id={item.file.id} className="mx-4 shrink-0" />
          <FilePreviewBody key={item.file.id} file={item.file} />
        </>
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
    case "browsers":
      return (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pt-1 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
          <BrowsersPanel />
        </div>
      );
    case "room":
      return (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1">
          <RoomTimeline roomId={item.roomId} />
        </div>
      );
  }
}

function Frame({ item, Title }: { item: WorkItem; Title: ElementType }) {
  const pane = useWorkPane();
  const { title, subtitle } = titleOf(item);
  return (
    <InWorkPane.Provider value>
      {pane !== null && pane.tabs.length > 1 && <TabStrip pane={pane} />}
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
          <Title className="line-clamp-2 text-base leading-snug font-semibold break-words outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
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
      <DialogContent showCloseButton={false} className={TALL_SHEET}>
        <Frame item={item} Title={SheetTitle} />
      </DialogContent>
    </Dialog>
  );
}
