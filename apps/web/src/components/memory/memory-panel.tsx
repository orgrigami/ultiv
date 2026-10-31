/**
 * What a bot remembers, in tabs: Facts, People & things, Core, Tidy, Files
 * (spec §13.2). The shell owns loading and refresh; each tab owns its own
 * writes and their errors. The same body renders in the dialog (MemoryPanel)
 * and inline on a bot's Crew profile (MemoryContent), where Files is its own
 * profile tab.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ErrorState } from "@/components/ui/empty-state";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { api, type ArtifactRow, type MemoryV2Fact, type MemoryV2State } from "@/lib/api";
import { cn } from "@/lib/utils";
import * as t from "@/lib/memory-text";
import { FactsTab } from "@/components/memory/facts-tab";
import { EntitiesTab } from "@/components/memory/entities-tab";
import { CoreTab } from "@/components/memory/core-tab";
import { TidyTab } from "@/components/memory/tidy-tab";
import { FilesTab } from "@/components/memory/files-tab";

export type MemoryTabId = "facts" | "people" | "core" | "tidy" | "files";

export interface MemoryData {
  /** This bot's store, raw: current, superseded, archived AND forgotten. */
  facts: MemoryV2Fact[];
  /** The workspace (owner) store's facts — shared memory. */
  sharedFacts: MemoryV2Fact[];
  /** Core lines: owner (workspace-wide) + this bot's own. */
  core: MemoryV2State["core"];
  /** Resolved entities from both stores (own + owner). */
  entities: MemoryV2State["entities"];
  /** Tidy proposals in this bot's store (open + accepted). */
  proposals: MemoryV2State["proposals"];
  /** Open tidy suggestions in this bot's store (badge on the Tidy tab). */
  openCount: number;
  artifacts: ArtifactRow[];
  kv: { key: string; value: string; updatedAt: number }[];
}

const ALL_TABS: readonly MemoryTabId[] = ["facts", "people", "core", "tidy", "files"];

function tabItems(
  openCount: number,
  only: readonly MemoryTabId[],
): { id: MemoryTabId; label: string; badge?: number }[] {
  const items: { id: MemoryTabId; label: string; badge?: number }[] = [
    { id: "facts", label: t.TABS.facts },
    { id: "people", label: t.TABS.people },
    { id: "core", label: t.TABS.core },
    { id: "tidy", label: t.TABS.tidy, ...(openCount > 0 ? { badge: openCount } : {}) },
    { id: "files", label: t.TABS.files },
  ];
  return items.filter((item) => only.includes(item.id));
}

function TabStrip({
  tab,
  onTab,
  openCount,
  tabs,
}: {
  tab: MemoryTabId;
  onTab: (next: MemoryTabId) => void;
  openCount: number;
  tabs: readonly MemoryTabId[];
}) {
  return (
    <div
      role="tablist"
      aria-label="Memory sections"
      className="border-border mt-3 flex gap-1 overflow-x-auto border-b pb-1"
    >
      {tabItems(openCount, tabs).map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          id={`memory-tab-${item.id}`}
          aria-selected={tab === item.id}
          aria-controls={`memory-tabpanel-${item.id}`}
          onClick={() => onTab(item.id)}
          className={cn(
            "focus-visible:ring-ring/50 pointer-coarse:min-h-11 pointer-coarse:min-w-11 flex shrink-0 items-center justify-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium outline-none focus-visible:ring-3",
            tab === item.id
              ? "bg-secondary text-secondary-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {item.label}
          {item.badge !== undefined && (
            <span className="bg-destructive/10 text-destructive rounded-4xl px-1.5 py-0.5 text-[10px] leading-none font-semibold">
              {item.badge}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

function MemoryBody({
  data,
  tab,
  onTab,
  profileId,
  name,
  reload,
  refreshError,
  initialQuery,
  tabs = ALL_TABS,
}: {
  tabs?: readonly MemoryTabId[] | undefined;
  data: MemoryData;
  tab: MemoryTabId;
  onTab: (next: MemoryTabId) => void;
  profileId: string;
  name: string;
  reload: () => Promise<void>;
  refreshError: string | null;
  /** Pre-fills the Facts tab's search (a memory chip deep link). */
  initialQuery?: string | undefined;
}) {
  const tabProps = {
    data,
    profileId,
    name,
    reload,
    ...(initialQuery !== undefined ? { initialQuery } : {}),
  };
  return (
    <>
      {tabs.length > 1 && (
        <TabStrip tab={tab} onTab={onTab} openCount={data.openCount} tabs={tabs} />
      )}
      {refreshError !== null && (
        <ErrorState
          message={`Refresh failed: ${refreshError}`}
          onRetry={() => void reload()}
          className="mt-2"
        />
      )}
      <div
        id={`memory-tabpanel-${tab}`}
        role={tabs.length > 1 ? "tabpanel" : undefined}
        aria-labelledby={tabs.length > 1 ? `memory-tab-${tab}` : undefined}
        className="mt-3 flex flex-col gap-2"
      >
        {tab === "facts" && <FactsTab {...tabProps} />}
        {tab === "people" && <EntitiesTab data={data} name={name} />}
        {tab === "core" && <CoreTab {...tabProps} />}
        {tab === "tidy" && <TidyTab {...tabProps} />}
        {tab === "files" && <FilesTab {...tabProps} />}
      </div>
      <p className="text-muted-foreground mt-3 text-xs">{t.footer}</p>
    </>
  );
}

/** Loads a bot's memory (both stores, files, KV state) while `enabled`. */
function useMemoryData(profileId: string, enabled: boolean) {
  const [data, setData] = useState<MemoryData | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async (): Promise<void> => {
    setStatus((current) => (current === "ready" ? "ready" : "loading"));
    try {
      const [bot, shared, files, kv] = await Promise.all([
        api.memoryV2(profileId),
        api.memoryV2("owner"),
        api.artifacts(profileId),
        api.stateOf(profileId),
      ]);
      setData({
        facts: bot.facts,
        sharedFacts: shared.facts,
        core: bot.core,
        entities: bot.entities,
        proposals: bot.proposals,
        openCount: bot.openCount,
        artifacts: Array.isArray(files) ? files : [],
        kv: Array.isArray(kv) ? kv : [],
      });
      setError(null);
      setStatus("ready");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setStatus((current) => (current === "ready" ? "ready" : "error"));
    }
  }, [profileId]);

  useEffect(() => {
    if (enabled) void load();
  }, [enabled, load]);
  return { data, status, error, load };
}

/** Loading and error lines shared by the dialog and the inline view. */
function MemoryStatus({
  status,
  error,
  load,
}: {
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  load: () => Promise<void>;
}) {
  return (
    <>
      {status === "loading" && <SkeletonRows label="Loading memory" className="mt-4" />}
      {status === "error" && (
        <div className="mt-4">
          <ErrorState message={error ?? "Couldn't load memory."} onRetry={() => void load()} />
        </div>
      )}
    </>
  );
}

/** The memory view inline (a Crew profile tab); `tabs` limits the sections. */
export function MemoryContent({
  profileId,
  name,
  tabs = ALL_TABS,
  initialQuery,
}: {
  profileId: string;
  name: string;
  tabs?: readonly MemoryTabId[];
  /** Pre-fills the Facts tab's search (a memory chip deep link). */
  initialQuery?: string | undefined;
}) {
  const { data, status, error, load } = useMemoryData(profileId, true);
  const [tab, setTab] = useState<MemoryTabId>(tabs[0] ?? "facts");
  return (
    <div className="flex flex-col">
      <MemoryStatus status={status} error={error} load={load} />
      {data !== null && status === "ready" && (
        <MemoryBody
          data={data}
          tab={tab}
          onTab={setTab}
          profileId={profileId}
          name={name}
          reload={load}
          refreshError={error}
          tabs={tabs}
          initialQuery={initialQuery}
        />
      )}
    </div>
  );
}

export function MemoryPanel({
  profileId,
  name,
  children,
  open: controlledOpen,
  onOpenChange,
  initialQuery,
}: {
  profileId: string;
  name: string;
  /** The trigger; omit it and drive `open` instead (e.g. from a menu item). */
  children?: React.ReactElement | undefined;
  open?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
  /** Pre-fills the Facts tab's search (a memory chip deep link). */
  initialQuery?: string | undefined;
}) {
  const [ownOpen, setOwnOpen] = useState(false);
  const open = controlledOpen ?? ownOpen;
  const setOpen = (next: boolean): void => {
    setOwnOpen(next);
    onOpenChange?.(next);
  };
  const [tab, setTab] = useState<MemoryTabId>("facts");
  const titleRef = useRef<HTMLHeadingElement | null>(null);

  // Focus the title, not the first fact's Forget button.
  useEffect(() => {
    if (open) {
      const id = window.setTimeout(() => titleRef.current?.focus(), 50);
      return () => window.clearTimeout(id);
    }
    return undefined;
  }, [open]);

  const { data, status, error, load } = useMemoryData(profileId, open);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {children !== undefined && <DialogTrigger render={children} />}
      <DialogContent>
        <DialogTitle ref={titleRef} tabIndex={-1} className="outline-none">
          {t.panelTitle(name)}
        </DialogTitle>
        <MemoryStatus status={status} error={error} load={load} />
        {data !== null && status === "ready" && (
          <MemoryBody
            data={data}
            tab={tab}
            onTab={setTab}
            profileId={profileId}
            name={name}
            reload={load}
            refreshError={error}
            initialQuery={initialQuery}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
