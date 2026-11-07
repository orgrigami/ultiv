/**
 * The Crew profile's tab list and the tabs that are its own: Overview (facts
 * and file-style cards to the rest), Access (approval mode, auto-approve and
 * tool rules) and Activity (the bot's read-only audit trail).
 */

import { CharacterEmpty } from "@/components/character-empty";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  BrainIcon,
  CalendarClockIcon,
  FlagIcon,
  FlaskConicalIcon,
  FolderIcon,
  HistoryIcon,
  ScrollTextIcon,
  ShieldCheckIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { AuditEvent, ProfileApprovalMode, ProfileInfo } from "@spriessen/contracts";
import { ApprovalModeChoice } from "@/components/approval-mode-control";
import { HostAccessSwitch } from "@/components/org-admin";
import { EditBotDialog } from "@/components/bot-dialog";
import { APPROVAL_MODE_HELP, AutoApproveField } from "@/components/bot-fields";
import { BotHomeField } from "@/components/department/bot-home";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { NavCard } from "@/components/nav-card";
import { Mark } from "@/components/state-mark";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ErrorState } from "@/components/ui/empty-state";
import { ListCard } from "@/components/ui/list-card";
import { SectionHeader } from "@/components/ui/section-header";
import { SkeletonRows } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { useApp } from "@/lib/app-state";
import { describeTool } from "@/lib/approval-text";
import { formatWhen } from "@/lib/format";
import { ACTIVITY_LIMIT, cardLine, type ProfileCounts } from "@/lib/profile-summary";
import { RowButton } from "@/components/ui/row-button";
import { cn } from "@/lib/utils";

export const PROFILE_TABS = [
  { id: "overview", label: "Overview" },
  { id: "instructions", label: "Instructions" },
  { id: "memory", label: "Memory" },
  { id: "projects", label: "Projects" },
  { id: "routines", label: "Routines" },
  { id: "access", label: "Access" },
  { id: "files", label: "Files" },
  { id: "activity", label: "Activity" },
  { id: "tests", label: "Tests" },
] as const;

export type ProfileTab = (typeof PROFILE_TABS)[number]["id"];

export const TAB_ICON: Partial<Record<ProfileTab, LucideIcon>> = {
  instructions: ScrollTextIcon,
  memory: BrainIcon,
  projects: FlagIcon,
  routines: CalendarClockIcon,
  access: ShieldCheckIcon,
  files: FolderIcon,
  activity: HistoryIcon,
  tests: FlaskConicalIcon,
};

export function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 px-3 py-2.5">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="min-w-0 text-sm break-words">{children}</dd>
    </div>
  );
}

export function OverviewTab({ bot, counts }: { bot: ProfileInfo; counts: ProfileCounts }) {
  const { sessions, mainId, refreshAll } = useApp();
  const navigate = useNavigate();
  const [instructions, setInstructions] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .botFiles(bot.id)
      .then((files) => alive && setInstructions(files.instructions.text))
      .catch(() => alive && setInstructions(null));
    return () => {
      alive = false;
    };
  }, [bot.id]);
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
        <Fact label="Persona">
          <span className="line-clamp-4 whitespace-pre-wrap">
            {bot.persona !== "" ? bot.persona : "Not set"}
          </span>
        </Fact>
        <Fact label="Instructions">
          <span className="line-clamp-4 whitespace-pre-wrap">
            {instructions === null ? "…" : instructions !== "" ? instructions : "Not set"}
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
      <ListCard className="rounded-2xl">
        <BotHomeField bot={bot} isMain={isMain} />
        {!isMain && !archived && (
          <ManageRow
            title="Make main bot"
            detail={
              bot.departmentId
                ? "The main bot lives in the org: move this bot to the org first."
                : "Opens first when you start."
            }
            disabled={Boolean(bot.departmentId)}
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
      </ListCard>
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

export function ManageRow({
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
    <RowButton
      disabled={disabled}
      onClick={onClick}
      className="hover:bg-muted/60 flex min-h-11 flex-col items-start gap-0.5 px-3 py-2.5 first:rounded-t-2xl last:rounded-b-2xl disabled:cursor-not-allowed disabled:opacity-60"
    >
      <span className={cn("text-sm", destructive && "text-destructive")}>{title}</span>
      <span className="text-muted-foreground text-xs">{detail}</span>
    </RowButton>
  );
}

export function AccessTab({ bot }: { bot: ProfileInfo }) {
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
  const learns = bot.policies.learnSkills !== false;
  const setLearning = async (learnSkills: boolean): Promise<void> => {
    try {
      await api.updateProfile(bot.id, { policies: { learnSkills } });
      setError(null);
      await refreshAll();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
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
      <SectionHeader title="This computer" />
      <HostAccessSwitch bot={bot} />
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
            ? "On. Commands run in this bot's home's VM — the org VM for an org bot, its department's VM otherwise — as its own Linux user."
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
                <Badge key={tool} variant="secondary" mono>
                  {tool}
                </Badge>
              ))}
            </span>
          )}
        </Fact>
      </dl>
      <SectionHeader title="Learning" />
      <label className="bg-card flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5">
        <Checkbox
          className="mt-0.5"
          checked={learns}
          onCheckedChange={(checked) => void setLearning(checked === true)}
          aria-label="Learns skills on its own"
        />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm">Learns skills on its own</span>
          <span className="text-muted-foreground text-xs">
            {learns
              ? `${bot.name} saves what a turn taught it as a skill without asking. You see "learned: …" in the chat and can undo it there or in Skills. It never copies web pages, documents or mail, secrets, or approval rules into a skill.`
              : `Off. ${bot.name} doesn't save skills on its own; it can still write one when you ask.`}
          </span>
        </span>
      </label>
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

export const KIND_LABEL: Record<AuditEvent["kind"], string> = {
  tool_call: "Tool",
  approval: "Approval",
  mailbox: "Message",
  escalation: "Needs you",
  credential: "Login",
  adjudication: "Jev",
  memory: "Memory",
  skills: "Skills",
  auth: "Sign-in",
  permission: "Access",
  vault: "Vault",
  reach: "Reach",
  shared_write: "Shared file",
};

/** Read-only: the newest 50 audit events for this bot, newest first. */
export function ActivityTab({ bot }: { bot: ProfileInfo }) {
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    api
      .auditOf(bot.id, ACTIVITY_LIMIT)
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
