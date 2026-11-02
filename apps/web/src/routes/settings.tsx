/**
 * Settings: how this server and this device are set up. Server shows a
 * first check (which keys are set, never their values; the microVM; who can
 * reach the server); then notifications, approvals, the vault, apps and
 * appearance. Bot-specific settings live on each bot's Crew profile.
 */
import { Link, createFileRoute } from "@tanstack/react-router";
import {
  BlocksIcon,
  ChevronRightIcon,
  KeyRoundIcon,
  SparklesIcon,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Page } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { PushToggle } from "@/components/push-toggle";
import { OrgSection } from "@/components/org-admin";
import { NodesPanel } from "@/components/nodes-panel";
import { Mark } from "@/components/state-mark";
import { ThemeSwitch } from "@/components/theme-switch";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { SectionHeader } from "@/components/ui/section-header";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import type { AuditEvent } from "@spriessen/contracts";
import { api, type ServerCheck } from "@/lib/api";
import {
  addPasskey,
  passkeys,
  passkeysSupported,
  removePasskey,
  signOut,
  UNAUTHORIZED_EVENT,
  type PasskeyRow,
} from "@/lib/auth";
import { authEventText } from "@/lib/auth-text";
import { APPROVAL_MODES, MODE_CHIP } from "@/lib/approval-mode";
import { cn } from "@/lib/utils";
import { Tile } from "@/components/ui/tile";

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
});

const card = "bg-card divide-border flex flex-col divide-y rounded-xl border";

function useServerCheck() {
  const [check, setCheck] = useState<ServerCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setCheck(await api.serverCheck());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);
  useEffect(() => void load(), [load]);
  return { check, error, load };
}

function SettingsPage() {
  const { check, error, load } = useServerCheck();
  const vaultOn = check?.keys.find((key) => key.names.includes("VAULT_KEY"))?.set;
  return (
    <Page title="Settings" lead="This server and this device. Each bot's own settings are in Crew.">
      <ServerSection check={check} error={error} reload={load} />
      <NodesPanel />
      <OrgSection />
      <PushToggle />
      <ApprovalsSection />
      <section aria-label="Apps and logins" className="flex flex-col gap-2">
        <SectionHeader title="Apps and logins" />
        <nav className={card}>
          <LinkRow
            to="connectors"
            icon={BlocksIcon}
            title="Connectors"
            detail="Apps your bots can use"
          />
          <LinkRow
            to="skills"
            icon={SparklesIcon}
            title="Skills"
            detail="Instructions your bots can follow"
          />
          <LinkRow
            to="vault"
            icon={KeyRoundIcon}
            title="Vault"
            detail={
              vaultOn === undefined
                ? "Saved logins and secrets"
                : vaultOn
                  ? "On. Saved logins and secrets, sealed on this server"
                  : "Off. Set VAULT_KEY on the server to turn it on"
            }
          />
        </nav>
      </section>
      <section aria-label="Appearance" className="flex flex-col gap-2">
        <SectionHeader title="Appearance" />
        <ThemeSwitch />
      </section>
      <section aria-label="Sign-in" className="flex flex-col gap-2">
        <SectionHeader title="Sign-in" />
        <SignOutRow />
        <PasskeyManager />
        <SecurityLog />
      </section>
    </Page>
  );
}

/**
 * Passkeys on this server: add one to the signed-in account (the browser
 * asks the authenticator), see what exists, remove one. The passcode stays
 * as the fallback whatever happens here.
 */
function PasskeyManager() {
  const [keys, setKeys] = useState<PasskeyRow[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const supported = passkeysSupported();
  const reload = useCallback(async (): Promise<void> => {
    try {
      setKeys(await passkeys());
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);
  useEffect(() => void reload(), [reload]);
  const add = async (): Promise<void> => {
    setError(null);
    setBusy("add");
    const result = await addPasskey();
    setBusy(null);
    if (result.ok) await reload();
    else setError(result.error ?? "That didn't work.");
  };
  const remove = async (id: string): Promise<void> => {
    setError(null);
    setBusy(id);
    const removed = await removePasskey(id);
    setBusy(null);
    if (!removed) setError("Couldn't remove that passkey. Try again.");
    await reload();
  };
  return (
    <div className={card}>
      <div className="flex items-center gap-3 px-3 py-2.5">
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-sm">Passkeys</span>
          <span className="text-muted-foreground text-xs">
            {supported
              ? "Sign in without typing the passcode. The passcode still works."
              : "This browser can't use passkeys here. They need HTTPS or localhost."}
          </span>
        </span>
        {supported && (
          <Button size="sm" disabled={busy !== null} onClick={() => void add()}>
            {busy === "add" && <Spinner />}
            Add a passkey
          </Button>
        )}
      </div>
      {error !== null && (
        <div className="px-3 py-2.5">
          <ErrorState message={error} />
        </div>
      )}
      {loadError && keys === null ? (
        <div className="px-3 py-2.5">
          <ErrorState message="Couldn't load the passkeys." onRetry={() => void reload()} />
        </div>
      ) : keys === null ? (
        <SkeletonRows
          label="Loading passkeys"
          rows={1}
          className="px-3 py-2.5"
          rowClassName="h-8 rounded-lg"
        />
      ) : keys.length === 0 ? (
        <EmptyState className="px-3 py-2.5 text-xs">No passkeys yet.</EmptyState>
      ) : (
        <ul aria-label="Passkeys" className="divide-border flex flex-col divide-y">
          {keys.map((key, index) => (
            <li key={key.id} className="flex min-h-12 items-center gap-3 px-3 py-2">
              <KeyRoundIcon className="text-muted-foreground size-4 shrink-0" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm">Passkey {index + 1}</span>
                <span className="text-muted-foreground truncate text-xs">
                  Added {stamp(key.createdAt)}
                </span>
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy !== null}
                aria-label={`Remove passkey ${index + 1}`}
                onClick={() => void remove(key.id)}
              >
                {busy === key.id && <Spinner />}
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const stamp = (at: number): string =>
  new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** The recent sign-in rows (this account only, newest first). */
function SecurityLog() {
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [error, setError] = useState(false);
  const load = useCallback(async (): Promise<void> => {
    try {
      setEvents((await api.auditKind("auth")).slice().reverse());
      setError(false);
    } catch {
      setError(true);
    }
  }, []);
  useEffect(() => void load(), [load]);
  return (
    <div className={card}>
      <p className="px-3 py-2.5 text-sm">Recent sign-in activity</p>
      {error && events === null ? (
        <div className="px-3 py-2.5">
          <ErrorState message="Couldn't load sign-in activity." onRetry={() => void load()} />
        </div>
      ) : events === null ? (
        <SkeletonRows
          label="Loading sign-in activity"
          rows={2}
          className="px-3 py-2.5"
          rowClassName="h-5 rounded-md"
        />
      ) : events.length === 0 ? (
        <EmptyState className="px-3 py-2.5 text-xs">Nothing recorded yet.</EmptyState>
      ) : (
        <ul aria-label="Recent sign-in activity" className="flex flex-col gap-1.5 px-3 py-2.5">
          {events.map((event, index) => (
            <li key={`${event.at}-${index}`} className="flex items-start gap-2 text-xs">
              <Mark
                kind={event.ok !== false ? "done" : "attention"}
                tone={event.ok !== false ? "ok" : "signal"}
                className="mt-0.5 size-3.5 shrink-0"
              />
              <span className="min-w-0 flex-1">
                {authEventText(event.name, event.ok, event.error)}
              </span>
              <time
                dateTime={new Date(event.at).toISOString()}
                className="text-muted-foreground shrink-0 tabular-nums"
              >
                {stamp(event.at)}
              </time>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Sign out of this server on this device; the sign-in gate takes over. */
function SignOutRow() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const out = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const result = await signOut();
    setBusy(false);
    if (result.ok) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    else setError(result.error ?? "Couldn't sign out. Try again.");
  };
  return (
    <div className={card}>
      <div className="flex items-center gap-3 px-3 py-2.5">
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-sm">This device</span>
          <span className="text-muted-foreground text-xs">
            Signed in. Signing out ends this device's session.
          </span>
        </span>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void out()}>
          {busy && <Spinner />}
          Sign out
        </Button>
      </div>
      {error !== null && (
        <div className="px-3 py-2.5">
          <ErrorState message={error} />
        </div>
      )}
    </div>
  );
}

function LinkRow({
  to,
  icon: Icon,
  title,
  detail,
}: {
  to: "connectors" | "skills" | "vault";
  icon: LucideIcon;
  title: string;
  detail: string;
}) {
  return (
    <Link
      to="/tools"
      search={to === "connectors" ? {} : { tab: to }}
      className="hover:bg-muted/60 focus-visible:ring-ring/50 flex min-h-12 items-center gap-3 px-3 py-2 outline-none first:rounded-t-xl last:rounded-b-xl focus-visible:ring-3"
    >
      <Icon className="text-muted-foreground size-4 shrink-0" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm">{title}</span>
        <span className="text-muted-foreground truncate text-xs">{detail}</span>
      </span>
      <ChevronRightIcon className="text-muted-foreground size-4 shrink-0" />
    </Link>
  );
}

function StatusLine({
  ok,
  warn = false,
  title,
  detail,
}: {
  ok: boolean;
  warn?: boolean;
  title: string;
  detail: string;
}) {
  return (
    <div className="flex items-start gap-3 px-3 py-2.5">
      <Mark
        kind={ok ? "done" : "attention"}
        tone={ok ? "ok" : warn ? "signal" : "muted"}
        className="mt-0.5 size-4 shrink-0"
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm">{title}</span>
        <span className="text-muted-foreground text-xs">{detail}</span>
      </span>
    </div>
  );
}

function ServerSection({
  check,
  error,
  reload,
}: {
  check: ServerCheck | null;
  error: string | null;
  reload: () => Promise<void>;
}) {
  if (error !== null && check === null)
    return (
      <section aria-label="Server" className="flex flex-col gap-2">
        <SectionHeader title="Server" />
        <ErrorState message={`Couldn't check the server: ${error}`} onRetry={() => void reload()} />
      </section>
    );
  if (check === null)
    return (
      <section aria-label="Server" className="flex flex-col gap-2">
        <SectionHeader title="Server" />
        <SkeletonRows label="Checking the server" rows={2} />
      </section>
    );
  const anyModel = check.keys.some((key) => key.group === "models" && key.set);
  return (
    <section aria-label="Server" className="flex flex-col gap-2">
      <SectionHeader title="Server" />
      <div className={card}>
        <StatusLine
          ok={check.listen.scope !== "all"}
          warn={check.listen.scope === "all"}
          title={
            check.listen.scope === "all"
              ? `Reachable from your network on port ${check.listen.port}`
              : check.listen.scope === "loopback"
                ? `Only this computer can reach it (port ${check.listen.port})`
                : `Listening on one address, port ${check.listen.port}`
          }
          detail={
            check.listen.scope === "all"
              ? "Anyone on the network can reach the sign-in. Set HOST=127.0.0.1 to keep the server off your network."
              : "Set by HOST in the server's environment."
          }
        />
        <StatusLine
          ok={check.microvm.available}
          title={check.microvm.available ? "Sandbox can run" : "Sandbox unavailable"}
          detail={check.microvm.detail}
        />
        <StatusLine
          ok={check.models.count > 0}
          warn={!anyModel}
          title={
            check.models.count > 0
              ? `${check.models.count} models from ${check.models.providers.length} provider${check.models.providers.length === 1 ? "" : "s"}`
              : "No models yet"
          }
          detail={
            check.models.count > 0
              ? `New chats start on ${check.models.default}.`
              : "Add a model provider key to the server's .env, then restart it."
          }
        />
      </div>
      <SectionHeader title="Keys" className="mt-1" />
      <p className="text-muted-foreground text-xs">
        Read from the server's environment. Only whether each is set is shown here.
      </p>
      <ul className={card}>
        {check.keys.map((key) => (
          <li key={key.names.join("+")} className="flex items-center gap-3 px-3 py-2.5">
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-sm">{key.enables}</span>
              <span className="text-muted-foreground font-mono text-xs break-all">
                {key.names.join(" + ")}
              </span>
            </span>
            <Badge variant={key.set ? "ok" : "muted"} className="shrink-0">
              {key.set ? "Set" : "Not set"}
            </Badge>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ApprovalsSection() {
  return (
    <section aria-label="Approvals" className="flex flex-col gap-2">
      <SectionHeader title="Approvals" />
      <Tile className="flex flex-col gap-3 p-3 text-sm">
        <p className="text-muted-foreground">
          New bots start in Manual: they ask you before each step that needs approval, such as
          running a command or sending something. You can change this per bot from the chip next to
          its name in chat, or on its Access tab in Crew.
        </p>
        <dl className="flex flex-col gap-2">
          {APPROVAL_MODES.map((mode) => (
            <div key={mode} className="flex gap-3">
              <dt
                className={cn(
                  "w-16 shrink-0 font-medium",
                  MODE_CHIP[mode].tone === "warning" && "text-warning",
                )}
              >
                {MODE_CHIP[mode].label}
              </dt>
              <dd className="text-muted-foreground">{MODE_CHIP[mode].hint}</dd>
            </div>
          ))}
        </dl>
        <p className="text-muted-foreground">
          Whatever the mode, a saved login's or connector's first use, connector changes and secret
          requests always ask you.
        </p>
      </Tile>
    </section>
  );
}
