/**
 * Facts tab: search, current/history toggle, this bot's facts plus the shared
 * (workspace) ones labelled, the forgotten list with restore, and the add
 * form. Forget/edit/restore route to the store the fact lives in.
 */
import { useState } from "react";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SectionHeader } from "@/components/ui/section-header";
import { FactRow, ForgottenList, HistoryView } from "@/components/memory/fact-views";
import type { MemoryData } from "@/components/memory/memory-panel";
import { api, type MemoryV2Fact } from "@/lib/api";
import { cn } from "@/lib/utils";
import * as t from "@/lib/memory-text";

interface TabProps {
  data: MemoryData;
  profileId: string;
  name: string;
  reload: () => Promise<void>;
  /** Pre-fills the search box (a memory chip deep link). */
  initialQuery?: string | undefined;
}

type View = "current" | "history";

const matches = (fact: MemoryV2Fact, query: string): boolean =>
  query === "" ||
  fact.text.toLowerCase().includes(query) ||
  fact.tags.some((tag) => tag.toLowerCase().includes(query));

export function FactsTab({ data, profileId, name, reload, initialQuery }: TabProps) {
  const [query, setQuery] = useState(initialQuery ?? "");
  const [view, setView] = useState<View>("current");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needle = query.trim().toLowerCase();
  const botFacts = data.facts.filter((fact) => fact.status !== "forgotten");
  const sharedFacts = data.sharedFacts.filter((fact) => fact.status !== "forgotten");

  const add = async (): Promise<void> => {
    if (draft.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      await api.profileMemoryAdd(profileId, draft.trim());
      setDraft("");
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="flex items-center gap-2">
        <Input
          className="flex-1"
          type="search"
          aria-label={t.searchLabel}
          placeholder={t.searchPlaceholder}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <ViewToggle view={view} onView={setView} />
      </div>
      {view === "history" ? (
        needle === "" ? (
          <HistoryView facts={botFacts} profileId={profileId} reload={reload} />
        ) : (
          <EmptyState>{t.noMatches}</EmptyState>
        )
      ) : (
        <>
          <CurrentView
            botFacts={botFacts.filter((fact) => matches(fact, needle))}
            sharedFacts={sharedFacts.filter((fact) => matches(fact, needle))}
            needle={needle}
            profileId={profileId}
            name={name}
            reload={reload}
          />
          <ForgottenList facts={data.facts} profileId={profileId} reload={reload} />
        </>
      )}
      <form
        className="mt-2 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <Input
          className="flex-1"
          aria-label={t.addLabel(name)}
          placeholder={t.addPlaceholder(name)}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button type="submit" variant="outline" size="sm" disabled={busy || draft.trim() === ""}>
          {busy ? "Saving…" : "Remember"}
        </Button>
      </form>
      {error !== null && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
    </>
  );
}

function ViewToggle({ view, onView }: { view: View; onView: (next: View) => void }) {
  return (
    <div
      role="group"
      aria-label="Facts view"
      className="border-border flex shrink-0 gap-0.5 rounded-lg border p-0.5"
    >
      {(["current", "history"] as const).map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={view === option}
          onClick={() => onView(option)}
          className={cn(
            "focus-visible:ring-ring/50 pointer-coarse:min-h-11 rounded-md px-2 py-1 text-xs font-medium outline-none focus-visible:ring-3",
            view === option
              ? "bg-secondary text-secondary-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option === "current" ? t.viewCurrent : t.viewHistory}
        </button>
      ))}
    </div>
  );
}

function CurrentView({
  botFacts,
  sharedFacts,
  needle,
  profileId,
  name,
  reload,
}: {
  botFacts: MemoryV2Fact[];
  sharedFacts: MemoryV2Fact[];
  needle: string;
  profileId: string;
  name: string;
  reload: () => Promise<void>;
}) {
  if (botFacts.length === 0 && sharedFacts.length === 0) {
    return <EmptyState>{needle === "" ? t.factsEmpty(name) : t.noMatches}</EmptyState>;
  }
  return (
    <>
      {botFacts.length > 0 && (
        <section className="flex flex-col gap-2">
          <SectionHeader title={t.factsBotTitle} />
          {botFacts.map((fact) => (
            <FactRow
              key={fact.id}
              fact={fact}
              shared={false}
              profileId={profileId}
              reload={reload}
            />
          ))}
        </section>
      )}
      {sharedFacts.length > 0 && (
        <section className="flex flex-col gap-2">
          <SectionHeader
            title={t.factsSharedTitle}
            action={
              <Badge variant="outline" className="w-fit">
                shared
              </Badge>
            }
          />
          {sharedFacts.map((fact) => (
            <FactRow key={fact.id} fact={fact} shared profileId={profileId} reload={reload} />
          ))}
        </section>
      )}
    </>
  );
}
