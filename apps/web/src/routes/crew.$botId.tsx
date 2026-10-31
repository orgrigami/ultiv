/**
 * One bot's profile, reached from Crew: its character big and centered,
 * then pill tabs with live counts (Overview · Memory n · Routines n ·
 * Access n · Files n · Activity). The tab rides ?tab= so Needs you and
 * other screens can deep-link to the exact section. Every tab reuses the
 * panel that already owned that job (memory, routines, the bot form, the
 * audit log); the overview is file-style cards into those tabs.
 */
import { CharacterEmpty } from "@/components/character-empty";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  BrainIcon,
  CalendarClockIcon,
  ChevronLeftIcon,
  FolderIcon,
  HistoryIcon,
  MessageCircleIcon,
  PencilIcon,
  ShieldCheckIcon,
  StarIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { AuditEvent, ProfileApprovalMode, ProfileInfo } from "@ultiv/contracts";
import { ApprovalModeChoice } from "@/components/approval-mode-control";
import { APPROVAL_MODE_HELP, AutoApproveField, EditBotDialog } from "@/components/bot-dialog";
import { BotAvatar } from "@/components/bot-avatar";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { MemoryContent } from "@/components/memory/memory-panel";
import { NavCard } from "@/components/nav-card";
import { Page } from "@/components/page";
import { RoutinesContent } from "@/components/routines-panel";
import { Mark } from "@/components/state-mark";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { SectionHeader } from "@/components/ui/section-header";
import { SkeletonRows } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { useApp } from "@/lib/app-state";
import { describeTool } from "@/lib/approval-text";
import { formatWhen } from "@/lib/format";
import { cardLine, tabCount, type ProfileCounts } from "@/lib/profile-summary";
import { cn } from "@/lib/utils";

export const PROFILE_TABS = [
  { id: "overview", label: "Overview" },
  { id: "memory", label: "Memory" },
  { id: "routines", label: "Routines" },
  { id: "access", label: "Access" },
  { id: "files", label: "Files" },
  { id: "activity", label: "Activity" },
] as const;

export type ProfileTab = (typeof PROFILE_TABS)[number]["id"];

const TAB_ICON: Partial<Record<ProfileTab, LucideIcon>> = {
  memory: BrainIcon,
  routines: CalendarClockIcon,
  access: ShieldCheckIcon,
  files: FolderIcon,
  activity: HistoryIcon,
};

/** Live numbers for the tabs; each one stays blank if its read fails. */
function useProfileCounts(botId: string, tab: ProfileTab): ProfileCounts {
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
    return () => {
      alive = false;
    };
    // Re-read when the tab changes: the open tab may have changed a count.
  }, [botId, tab]);
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
  const counts = useProfileCounts(bot.id, active);
  const botId = bot.id;
  return (
    <Page
      back={<BackToCrew />}
      docTitle={bot.name}
      title={bot.name}
      hero={
        <div className="flex flex-col items-center gap-2 pt-1 pb-2 text-center">
          <BotAvatar id={bot.id} name={bot.name} size="hero" />
          <h1 className="font-heading text-title mt-1 flex max-w-full items-center gap-1.5 font-semibold tracking-tight">
            <span className="truncate">{bot.name}</span>
            {isMain && (
              <StarIcon className="fill-live text-live size-4 shrink-0" aria-label="Main bot" />
            )}
            {bot.archivedAt !== null && <Badge variant="outline">Hidden</Badge>}
          </h1>
          <p className="text-muted-foreground max-w-sm text-sm">
            {bot.description !== "" ? bot.description : "No role yet"}
          </p>
          <div className="mt-1 flex gap-2">
            <Button
              className="rounded-full px-4"
              onClick={() => void navigate({ to: "/", search: isMain ? {} : { bot: bot.id } })}
            >
              <MessageCircleIcon /> Open chat
            </Button>
            <Button
              variant="outline"
              className="rounded-full px-4"
              onClick={() => setEditing(true)}
            >
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
        className="tab-strip -mx-3 flex snap-x scroll-px-3 gap-1 overflow-x-auto pr-8 pb-1 pl-3 sm:mx-0 sm:px-0"
      >
        {PROFILE_TABS.map((entry) => {
          const count = tabCount(entry.id, counts, bot);
          return (
            <Link
              key={entry.id}
              to="/crew/$botId"
              params={{ botId }}
              search={entry.id === "overview" ? {} : { tab: entry.id }}
              role="tab"
              aria-selected={active === entry.id}
              // Keep the open tab in view when the strip scrolls on a phone.
              ref={(node) => {
                if (node !== null && active === entry.id) {
                  node.scrollIntoView({ block: "nearest", inline: "nearest" });
                }
              }}
              className={cn(
                "press focus-visible:ring-ring/50 flex min-h-11 shrink-0 snap-start items-center gap-1.5 rounded-full border px-3.5 text-sm outline-none focus-visible:ring-3 sm:min-h-9",
                active === entry.id
                  ? "bg-foreground text-background border-transparent font-medium"
                  : "text-muted-foreground hover:text-foreground bg-card",
              )}
            >
              {entry.label}
              {count !== undefined && (
                <span
                  className={cn(
                    "min-w-5 rounded-full px-1.5 text-center text-xs tabular-nums",
                    active === entry.id ? "bg-background/15" : "bg-muted",
                  )}
                >
                  {" "}
                  {count}
                </span>
              )}
            </Link>
          );
        })}
      </div>
      <div role="tabpanel" aria-label={PROFILE_TABS.find((t) => t.id === active)?.label}>
        {active === "overview" && <OverviewTab bot={bot} counts={counts} />}
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

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 px-3 py-2.5">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="min-w-0 text-sm break-words">{children}</dd>
    </div>
  );
}

function OverviewTab({ bot, counts }: { bot: ProfileInfo; counts: ProfileCounts }) {
  const { sessions, mainId, refreshAll } = useApp();
  const navigate = useNavigate();
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMain = bot.id === mainId;
  const archived = bot.archivedAt !== null;
  const visible = sessions.profiles.filter((profile) => profile.archivedAt === null).length;
  // Mirrors the server's 409s, so the reason shows before the click.
  const deleteBlocked =
    sessions.profiles.length <= 1
      ? "You need at least one bot."
      : isMain
        ? "Make another bot the main one first."
        : null;
  const model =
    bot.model === null
      ? "Default model"
      : (sessions.models.find((entry) => entry.id === bot.model?.id)?.label ?? bot.model.id);
  const act = async (run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
      setError(null);
      await refreshAll();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <div className="flex flex-col gap-4">
      {error !== null && <ErrorState message={error} />}
      <div className="grid gap-2 sm:grid-cols-2">
        {PROFILE_TABS.filter((entry) => entry.id !== "overview").map((entry) => (
          <NavCard
            key={entry.id}
            to="/crew/$botId"
            params={{ botId: bot.id }}
            search={{ tab: entry.id }}
            icon={TAB_ICON[entry.id] ?? BrainIcon}
            title={entry.label}
            detail={cardLine(entry.id, counts, bot)}
          />
        ))}
      </div>
      <SectionHeader title="Details" />
      <dl className="bg-card divide-border divide-y rounded-2xl border">
        <Fact label="Personality">
          <span className="line-clamp-4 whitespace-pre-wrap">
            {bot.persona !== "" ? bot.persona : "Not set"}
          </span>
        </Fact>
        <Fact label="Model">
          {model}
          {bot.model?.effort ? ` · ${bot.model.effort} effort` : ""}
        </Fact>
        <Fact label="Timezone">{bot.timezone ?? "Server default"}</Fact>
        <Fact label="Created">{formatWhen(bot.createdAt)}</Fact>
      </dl>
      <SectionHeader title="Manage" />
      <div className="bg-card divide-border flex flex-col divide-y rounded-2xl border">
        {!isMain && !archived && (
          <ManageRow
            title="Make main bot"
            detail="Opens first when you start."
            onClick={() => void act(() => api.setMain(bot.id))}
          />
        )}
        {!isMain && (
          <ManageRow
            title={archived ? "Unhide" : "Hide"}
            detail={
              archived
                ? "Brings it back to the crew."
                : "Moves it under Hidden. Nothing is deleted."
            }
            disabled={!archived && visible <= 1}
            onClick={() =>
              void act(() => (archived ? api.unarchiveProfile(bot.id) : api.archiveProfile(bot.id)))
            }
          />
        )}
        <ManageRow
          title="Delete bot…"
          detail={deleteBlocked ?? "Removes its chats, memory and files for good."}
          destructive
          disabled={deleteBlocked !== null}
          onClick={() => setRemoving(true)}
        />
      </div>
      <ConfirmDialog
        title={`Delete ${bot.name}?`}
        warning="This permanently removes the bot with all of their chats, memory and artifacts. It cannot be undone."
        typed={bot.name}
        confirmLabel="Delete bot"
        open={removing}
        onOpenChange={setRemoving}
        onConfirm={async () => {
          await api.deleteProfile(bot.id);
          await refreshAll();
          void navigate({ to: "/crew", replace: true });
        }}
      />
    </div>
  );
}

function ManageRow({
  title,
  detail,
  destructive = false,
  disabled = false,
  onClick,
}: {
  title: string;
  detail: string;
  destructive?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="hover:bg-muted/60 focus-visible:ring-ring/50 flex min-h-11 cursor-pointer flex-col items-start gap-0.5 px-3 py-2.5 text-left outline-none first:rounded-t-2xl last:rounded-b-2xl focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-60"
    >
      <span className={cn("text-sm", destructive && "text-destructive")}>{title}</span>
      <span className="text-muted-foreground text-xs">{detail}</span>
    </button>
  );
}

function AccessTab({ bot }: { bot: ProfileInfo }) {
  const { sessions, refreshAll } = useApp();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setMode = async (approvalMode: ProfileApprovalMode): Promise<void> => {
    try {
      await api.updateProfile(bot.id, { policies: { approvalMode } });
      setError(null);
      await refreshAll();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const sandboxed = bot.policies.sandbox !== false;
  return (
    <div className="flex flex-col gap-4">
      <SectionHeader title="Who approves its steps" />
      {error !== null && <ErrorState message={error} />}
      <ApprovalModeChoice
        botName={bot.name}
        mode={bot.policies.approvalMode}
        help={APPROVAL_MODE_HELP}
        onChange={setMode}
      />
      <AutoApproveField bot={bot} refresh={refreshAll} />
      <SectionHeader
        title="Tools"
        action={
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            Change
          </Button>
        }
      />
      <dl className="bg-card divide-border divide-y rounded-xl border">
        <Fact label="Sandboxed shell">
          {sandboxed
            ? "On. Commands run in this bot's own microVM."
            : "Off. Only the host shell is available, and it always asks you."}
        </Fact>
        <Fact label="Tool list">
          {bot.toolAllowlist === null ? (
            "Every tool"
          ) : bot.toolAllowlist.length === 0 ? (
            "No tools"
          ) : (
            <span className="flex flex-wrap gap-1">
              {bot.toolAllowlist.map((tool) => (
                <Badge key={tool} variant="secondary" className="font-mono">
                  {tool}
                </Badge>
              ))}
            </span>
          )}
        </Fact>
      </dl>
      <p className="text-muted-foreground text-sm">
        Apps and saved logins are shared by the crew. Manage them in{" "}
        <Link to="/tools" className="text-foreground underline underline-offset-4">
          Connectors
        </Link>{" "}
        and{" "}
        <Link
          to="/tools"
          search={{ tab: "vault" }}
          className="text-foreground underline underline-offset-4"
        >
          Vault
        </Link>
        .
      </p>
      <EditBotDialog
        bot={bot}
        models={sessions.models}
        open={editing}
        onOpenChange={setEditing}
        refresh={refreshAll}
      />
    </div>
  );
}

const KIND_LABEL: Record<AuditEvent["kind"], string> = {
  tool_call: "Tool",
  approval: "Approval",
  mailbox: "Message",
  escalation: "Needs you",
  credential: "Login",
  adjudication: "Jev",
  memory: "Memory",
  skills: "Skills",
};

/** Read-only: the newest 50 audit events for this bot, newest first. */
function ActivityTab({ bot }: { bot: ProfileInfo }) {
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    api
      .auditOf(bot.id, 50)
      .then((rows) => {
        if (!alive) return;
        setEvents([...rows].reverse());
        setError(null);
      })
      .catch((cause) => alive && setError(cause instanceof Error ? cause.message : String(cause)));
    return () => {
      alive = false;
    };
  }, [bot.id, attempt]);
  if (error !== null)
    return (
      <ErrorState
        message={`Couldn't load activity: ${error}`}
        onRetry={() => setAttempt((n) => n + 1)}
      />
    );
  if (events === null) return <SkeletonRows label="Loading activity" />;
  if (events.length === 0)
    return (
      <CharacterEmpty bot={bot} title="Nothing yet">
        What {bot.name} does shows up here once it starts working.
      </CharacterEmpty>
    );
  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground text-xs">
        The last {events.length} things {bot.name} did that are logged: tool calls, approvals,
        logins and memory changes. Read-only.
      </p>
      <ul className="bg-card divide-border divide-y rounded-xl border">
        {events.map((event, index) => (
          <li key={`${event.at}-${index}`} className="flex items-start gap-2.5 px-3 py-2.5">
            <Mark
              kind={event.ok === false ? "error" : "done"}
              tone={event.ok === false ? "signal" : "muted"}
              className="mt-0.5 size-3.5 shrink-0"
            />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-sm break-words">
                {event.name === null ? KIND_LABEL[event.kind] : describeTool(event.name).action}
              </span>
              {event.error !== null && (
                <span className="text-signal text-xs break-words">{event.error}</span>
              )}
              <span className="text-muted-foreground text-xs">
                {KIND_LABEL[event.kind]} · {formatWhen(event.at)}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
