/**
 * One bot's profile, reached from Crew: its character big and centered,
 * then pill tabs with live counts (Overview · Instructions n · Memory n ·
 * Routines n · Access n|All · Files n · Activity n). Overview is the index
 * of the others, so it carries no count. Instructions edits the
 * bot's Persona and Instructions files with their versions. The tab rides ?tab= so Needs you and
 * other screens can deep-link to the exact section. Every tab reuses the
 * panel that already owned that job (memory, routines, the bot form, the
 * audit log); the overview is file-style cards into those tabs.
 */
import { BotFilesEditor } from "@/components/bot-files-editor";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { ChevronLeftIcon, MessageCircleIcon, PencilIcon, StarIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { ProfileInfo } from "@spriessen/contracts";
import { EditBotDialog } from "@/components/bot-dialog";
import { BotAvatar } from "@/components/bot-avatar";
import { HomeLabel } from "@/components/department/bot-home";
import { MemoryContent } from "@/components/memory/memory-panel";
import { Page } from "@/components/page";
import { RoutinesContent } from "@/components/routines-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { api } from "@/lib/api";
import { useApp } from "@/lib/app-state";
import { ACTIVITY_LIMIT, tabCount, type ProfileCounts } from "@/lib/profile-summary";
import { Heading } from "@/components/ui/heading";
import {
  AccessTab,
  ActivityTab,
  OverviewTab,
  PROFILE_TABS,
  type ProfileTab,
} from "@/components/profile-tabs";

/** Live numbers for the tabs; each one stays blank if its read fails. */
function useProfileCounts(botId: string, tab: ProfileTab, epoch = 0): ProfileCounts {
  const [counts, setCounts] = useState<ProfileCounts>({});
  useEffect(() => {
    let alive = true;
    const settle = (patch: ProfileCounts): void => {
      if (alive) setCounts((now) => ({ ...now, ...patch }));
    };
    api
      .memoryV2(botId)
      .then((state) =>
        settle({
          memory: state.facts.filter(
            (fact) => fact.status === "current" && fact.scope === "profile",
          ).length,
        }),
      )
      .catch(() => settle({ memory: undefined }));
    Promise.all([api.cron(), api.webhooks(), api.sensors()])
      .then(([cron, hooks, sensors]) =>
        settle({
          routines: [...cron, ...hooks, ...sensors].filter((row) => row.profile === botId).length,
        }),
      )
      .catch(() => settle({ routines: undefined }));
    api
      .artifacts(botId)
      .then((rows) => settle({ files: rows.length }))
      .catch(() => settle({ files: undefined }));
    api
      .botFiles(botId)
      .then((files) => settle({ versions: files.persona.version + files.instructions.version }))
      .catch(() => settle({ versions: undefined }));
    api
      .auditOf(botId, ACTIVITY_LIMIT)
      .then((rows) => settle({ activity: rows.length }))
      .catch(() => settle({ activity: undefined }));
    return () => {
      alive = false;
    };
    // Re-read when the tab changes (the open tab may have changed a count)
    // and after a save on the open tab (`epoch`).
  }, [botId, tab, epoch]);
  return counts;
}

export const Route = createFileRoute("/crew/$botId")({
  validateSearch: (search: Record<string, unknown>): { tab?: ProfileTab } =>
    PROFILE_TABS.some((tab) => tab.id === search.tab) && search.tab !== "overview"
      ? { tab: search.tab as ProfileTab }
      : {},
  component: ProfilePage,
});

function BackToCrew() {
  return (
    <Link
      to="/crew"
      className="text-muted-foreground hover:text-foreground -ml-1 inline-flex min-h-11 items-center gap-1 self-start rounded-lg pr-2 text-sm sm:min-h-8"
    >
      <ChevronLeftIcon className="size-4" /> Crew
    </Link>
  );
}

function ProfilePage() {
  const { botId } = Route.useParams();
  const { tab } = Route.useSearch();
  const { sessions, mainId } = useApp();
  const active: ProfileTab = tab ?? "overview";
  const bot = sessions.profiles.find((profile) => profile.id === botId);

  if (bot === undefined) {
    return (
      <Page title="Bot not found" back={<BackToCrew />}>
        {sessions.phase === "connecting" ? (
          <div className="flex flex-col items-center gap-3 py-4" role="status" aria-label="Loading">
            <div className="skeleton size-24 rounded-full" />
            <div className="skeleton h-5 w-32 rounded-full" />
          </div>
        ) : (
          <EmptyState>This bot was removed, or the link is from another workspace.</EmptyState>
        )}
      </Page>
    );
  }
  return <Profile bot={bot} active={active} isMain={bot.id === mainId} />;
}

function Profile({
  bot,
  active,
  isMain,
}: {
  bot: ProfileInfo;
  active: ProfileTab;
  isMain: boolean;
}) {
  const { sessions, refreshAll } = useApp();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [countsEpoch, setCountsEpoch] = useState(0);
  const counts = useProfileCounts(bot.id, active, countsEpoch);
  const botId = bot.id;
  return (
    <Page
      back={<BackToCrew />}
      docTitle={bot.name}
      title={bot.name}
      hero={
        <div className="flex flex-col items-center gap-2 pt-1 pb-2 text-center">
          <BotAvatar id={bot.id} name={bot.name} size="hero" />
          <Heading level={1} size="title" className="mt-1 flex max-w-full items-center gap-1.5">
            <span className="truncate">{bot.name}</span>
            {isMain && (
              <StarIcon className="fill-live text-live size-4 shrink-0" aria-label="Main bot" />
            )}
            {bot.archivedAt !== null && <Badge variant="outline">Hidden</Badge>}
          </Heading>
          <p className="text-muted-foreground max-w-sm text-sm">
            {bot.description !== "" ? bot.description : "No role yet"}
          </p>
          <HomeLabel bot={bot} />
          <div className="mt-1 flex gap-2">
            <Button
              size="lg"
              pill
              onClick={() => void navigate({ to: "/", search: isMain ? {} : { bot: bot.id } })}
            >
              <MessageCircleIcon /> Open chat
            </Button>
            <Button variant="outline" size="lg" pill onClick={() => setEditing(true)}>
              <PencilIcon /> Edit
            </Button>
          </div>
          <EditBotDialog
            bot={bot}
            models={sessions.models}
            open={editing}
            onOpenChange={setEditing}
            refresh={refreshAll}
          />
        </div>
      }
    >
      <div
        role="tablist"
        aria-label="Profile sections"
        className="no-scrollbar scroll-fade-x -mx-3 flex snap-x scroll-px-3 gap-1.5 overflow-x-auto px-3 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:[mask-image:none]"
      >
        {PROFILE_TABS.map((entry) => {
          const count = tabCount(entry.id, counts, bot);
          return (
            <Button
              key={entry.id}
              variant="filter"
              pill
              nativeButton={false}
              render={
                <Link
                  to="/crew/$botId"
                  params={{ botId }}
                  search={entry.id === "overview" ? {} : { tab: entry.id }}
                  role="tab"
                  aria-selected={active === entry.id}
                  // Keep the open tab in view when the strip scrolls on a phone.
                  ref={(node) => {
                    if (node !== null && active === entry.id) {
                      node.scrollIntoView({ block: "nearest", inline: "center" });
                    }
                  }}
                />
              }
              className="press shrink-0 snap-start"
            >
              {entry.label}
              {count !== undefined && (
                <Badge size="count" variant={active === entry.id ? "overlay" : "muted"}>
                  {count}
                </Badge>
              )}
            </Button>
          );
        })}
      </div>
      <div role="tabpanel" aria-label={PROFILE_TABS.find((t) => t.id === active)?.label}>
        {active === "overview" && <OverviewTab bot={bot} counts={counts} />}
        {active === "instructions" && (
          <BotFilesEditor
            key={bot.id}
            botId={bot.id}
            onSaved={() => {
              setCountsEpoch((n) => n + 1);
              void refreshAll();
            }}
          />
        )}
        {active === "memory" && (
          <MemoryContent
            key={bot.id}
            profileId={bot.id}
            name={bot.name}
            tabs={["facts", "people", "core", "tidy"]}
          />
        )}
        {active === "routines" && <RoutinesContent profiles={sessions.profiles} botId={bot.id} />}
        {active === "access" && <AccessTab bot={bot} />}
        {active === "files" && (
          <MemoryContent key={bot.id} profileId={bot.id} name={bot.name} tabs={["files"]} />
        )}
        {active === "activity" && <ActivityTab bot={bot} />}
      </div>
    </Page>
  );
}
