/**
 * "What <bot> can do here", in one place: the effective answer behind every
 * switch that shapes a bot's reach — who approves its steps, its shell (the
 * bot's sandbox switch AND whether this server can run the microVM), this
 * computer and paired nodes (org AND team AND bot, with the level that
 * blocks it and where to fix it), its tools, the saved logins it may spend
 * on the web, and what always reaches the owner. Pure; the Access tab feeds
 * it what the app already loads.
 */
import type { CredentialBinding, ProfileInfo } from "@spriessen/contracts";
import { plural } from "@spriessen/present/plural";

export type AccessTone = "on" | "off" | "asks";

export interface AccessLine {
  readonly label: string;
  readonly tone: AccessTone;
  readonly text: string;
  /** Where to change it, when that isn't this tab. */
  readonly fix?: string;
}

export interface AccessInput {
  readonly bot: Pick<ProfileInfo, "id" | "name" | "policies" | "toolAllowlist">;
  /** This server can run the microVM (server check); null = unknown. */
  readonly microvm: boolean | null;
  /** The host-access matrix row; null = not loaded. */
  readonly host: { readonly allowed: boolean; readonly blockedBy: string | null } | null;
  /** Vault bindings (null = not loaded). */
  readonly bindings: readonly Pick<CredentialBinding, "profiles" | "hosts">[] | null;
}

const MODE: Record<string, { tone: AccessTone; text: string }> = {
  manual: { tone: "asks", text: "Every step with side effects asks you first." },
  jev: {
    tone: "asks",
    text: "Jev approves the steps it is sure of, refuses the ones it is sure are wrong, and asks you about the rest.",
  },
  yolo: {
    tone: "on",
    text: "Steps run without asking, scripts on this computer too when it is allowed below.",
  },
};

const approvals = (bot: AccessInput["bot"]): AccessLine => {
  const mode = MODE[bot.policies.approvalMode] ?? MODE["manual"]!;
  const rules = bot.policies.autoApprove.length;
  const saved =
    rules === 0
      ? ""
      : ` ${rules} always-allowed ${plural(rules, "rule skips", "rules skip")} the question.`;
  return {
    label: "Approvals",
    tone: mode.tone,
    text: `${mode.text}${bot.policies.approvalMode === "yolo" ? "" : saved}`,
  };
};

const shell = (bot: AccessInput["bot"], microvm: boolean | null): AccessLine => {
  if (bot.policies.sandbox === false)
    return { label: "Shell", tone: "off", text: "Off for this bot: no sandboxed shell." };
  if (microvm === false)
    return {
      label: "Shell",
      tone: "off",
      text: "This server can't run the sandbox (it needs macOS on Apple silicon or Linux with KVM), so no shell.",
      fix: "Settings › Server",
    };
  return {
    label: "Shell",
    tone: "on",
    text: "Runs scripts in its home's sandboxed computer, as its own user.",
  };
};

const BLOCKED: Record<string, { text: string; fix: string }> = {
  org: { text: "the org switch is off", fix: "Settings › Organization" },
  team: { text: "its team's switch is off", fix: "its team's page in Crew" },
  bot: { text: "its own switch is off", fix: "the switch below" },
};

const host = (row: AccessInput["host"]): AccessLine => {
  if (row === null)
    return { label: "This computer", tone: "off", text: "Unknown until the switches load." };
  if (row.allowed)
    return {
      label: "This computer",
      tone: "asks",
      text: "May run scripts on this computer and your paired nodes. Each one asks you unless you saved that exact script.",
    };
  const why = BLOCKED[row.blockedBy ?? ""];
  return {
    label: "This computer",
    tone: "off",
    text:
      why === undefined
        ? "No access to this computer or your paired nodes."
        : `No access: ${why.text}.`,
    ...(why !== undefined ? { fix: why.fix } : {}),
  };
};

const tools = (allowlist: AccessInput["bot"]["toolAllowlist"]): AccessLine =>
  allowlist === null
    ? { label: "Tools", tone: "on", text: "Every installed tool, including ones installed later." }
    : allowlist.length === 0
      ? { label: "Tools", tone: "off", text: "No tools beyond its own memory, tasks and messages." }
      : {
          label: "Tools",
          tone: "on",
          text: `${allowlist.length} chosen ${plural(allowlist.length, "tool", "tools")}; new tools stay out until you add them.`,
        };

const logins = (botId: string, bindings: AccessInput["bindings"]): AccessLine => {
  if (bindings === null)
    return { label: "Saved logins", tone: "off", text: "Unknown until the vault loads." };
  const usable = bindings.filter((row) => row.profiles === null || row.profiles.includes(botId));
  if (usable.length === 0)
    return {
      label: "Saved logins",
      tone: "off",
      text: "None it may use on the web.",
      fix: "Vault › Allow web use",
    };
  const hosts = [...new Set(usable.flatMap((row) => row.hosts))];
  const shown =
    hosts.slice(0, 3).join(", ") + (hosts.length > 3 ? ` and ${hosts.length - 3} more` : "");
  return {
    label: "Saved logins",
    tone: "asks",
    text: `${usable.length} it may use, only on ${shown}. The first use on each site asks you.`,
  };
};

export const ALWAYS_ASKS =
  "Whatever the mode, these always ask you: a saved login's first use on a site, a connector's first use, changes to connectors, and requests for a secret.";

export function effectiveAccess(input: AccessInput): AccessLine[] {
  return [
    approvals(input.bot),
    shell(input.bot, input.microvm),
    host(input.host),
    tools(input.bot.toolAllowlist),
    logins(input.bot.id, input.bindings),
  ];
}
