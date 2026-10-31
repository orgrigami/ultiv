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
import { PushToggle } from "@/components/push-toggle";
import { Mark } from "@/components/state-mark";
import { ThemeSwitch } from "@/components/theme-switch";
import { ErrorState } from "@/components/ui/empty-state";
import { SectionHeader } from "@/components/ui/section-header";
import { Spinner } from "@/components/ui/spinner";
import { api, type ServerCheck } from "@/lib/api";
import { APPROVAL_MODES, MODE_CHIP } from "@/lib/approval-mode";
import { cn } from "@/lib/utils";

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
    </Page>
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
        <p className="text-muted-foreground flex items-center gap-2 text-sm">
          <Spinner /> Checking the server…
        </p>
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
              ? "Anyone on the same Wi-Fi or tailnet can open the app, and there is no sign-in yet. Set HOST=127.0.0.1 to keep it on this computer."
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
            <span
              className={cn(
                "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium",
                key.set ? "bg-ok/15 text-ok" : "bg-muted text-muted-foreground",
              )}
            >
              {key.set ? "Set" : "Not set"}
            </span>
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
      <div className="bg-card flex flex-col gap-3 rounded-xl border p-3 text-sm">
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
      </div>
    </section>
  );
}
