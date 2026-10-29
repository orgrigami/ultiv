/**
 * What a bot remembers, in tabs: Facts, People & things, Core, Tidy, Files
 * (spec §13.2). The shell owns loading and refresh; each tab owns its own
 * writes and their errors.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ErrorState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
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

function tabItems(openCount: number): { id: MemoryTabId; label: string; badge?: number }[] {
  return [
    { id: "facts", label: t.TABS.facts },
    { id: "people", label: t.TABS.people },
    { id: "core", label: t.TABS.core },
    { id: "tidy", label: t.TABS.tidy, ...(openCount > 0 ? { badge: openCount } : {}) },
    { id: "files", label: t.TABS.files },
  ];
}

function TabStrip({
  tab,
  onTab,
  openCount,
}: {
  tab: MemoryTabId;
  onTab: (next: MemoryTabId) => void;
  openCount: number;
}) {
  return (
    <div
      role="tablist"
      aria-label="Memory sections"
      className="border-border mt-3 flex gap-1 overflow-x-auto border-b pb-1"
    >
      {tabItems(openCount).map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          id={`memory-tab-${item.id}`}
          aria-selected={tab === item.id}
          aria-controls={`memory-tabpanel-${item.id}`}
          onClick={() => onTab(item.id)}
          className={cn(
            "focus-visible:ring-ring/50 pointer-coarse:min-h-11 flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium outline-none focus-visible:ring-3",
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
}: {
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
      <TabStrip tab={tab} onTab={onTab} openCount={data.openCount} />
      {refreshError !== null && (
        <ErrorState
          message={`Refresh failed: ${refreshError}`}
          onRetry={() => void reload()}
          className="mt-2"
        />
      )}
      <div
        id={`memory-tabpanel-${tab}`}
        role="tabpanel"
        aria-labelledby={`memory-tab-${tab}`}
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
  const [data, setData] = useState<MemoryData | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
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
    if (open) void load();
  }, [open, load]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {children !== undefined && <DialogTrigger render={children} />}
      <DialogContent>
        <DialogTitle ref={titleRef} tabIndex={-1} className="outline-none">
          {t.panelTitle(name)}
        </DialogTitle>
        {status === "loading" && (
          <p className="text-muted-foreground mt-4 flex items-center gap-2 text-sm">
            <Spinner /> Loading memory…
          </p>
        )}
        {status === "error" && (
          <div className="mt-4">
            <ErrorState message={error ?? "Something went wrong."} onRetry={() => void load()} />
          </div>
        )}
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
