/**
 * GET /api/server/check — a read-only first look at how this server is set
 * up, for Settings › Server. It reports which keys are set (true/false, and
 * what each turns on), never a value; which model providers the catalog
 * found; whether the microVM sandbox can likely run here; and whether the
 * server listens beyond this machine.
 */
import { existsSync } from "node:fs";
import type { RouteArgs } from "./types.ts";

export interface KeyCheck {
  /** The env var name(s); a group is set only when all are. */
  names: string[];
  set: boolean;
  /** What it turns on, in a few words. */
  enables: string;
  group: "models" | "features";
}

export interface ServerCheck {
  keys: KeyCheck[];
  models: { providers: string[]; count: number; default: string; source: string };
  microvm: { available: boolean; detail: string };
  listen: {
    port: number;
    /** all = every interface (LAN and tailnet too); loopback = this machine only. */
    scope: "all" | "loopback" | "specific";
  };
}

const KEYS: readonly Omit<KeyCheck, "set">[] = [
  { names: ["KENARI_API_KEY"], enables: "Kenari models", group: "models" },
  { names: ["ANTHROPIC_API_KEY"], enables: "Anthropic models", group: "models" },
  { names: ["OPENAI_API_KEY"], enables: "OpenAI models", group: "models" },
  { names: ["OPENROUTER_API_KEY"], enables: "OpenRouter models", group: "models" },
  { names: ["GOOGLE_GENERATIVE_AI_API_KEY"], enables: "Google models", group: "models" },
  { names: ["TYPESAFE_API_KEY"], enables: "Jev, the approval reviewer", group: "features" },
  { names: ["VAULT_KEY"], enables: "The vault for saved logins", group: "features" },
  {
    names: ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY"],
    enables: "Push notifications",
    group: "features",
  },
  {
    names: ["RESEND_API_KEY", "EMAIL_FROM", "ESCALATION_EMAIL"],
    enables: "Email when a routine needs you",
    group: "features",
  },
  { names: ["TINYFISH_API_KEY"], enables: "Web search and page fetch", group: "features" },
  { names: ["CALENDAR_ICS_URL"], enables: "Calendar awareness", group: "features" },
];

const isSet = (value: string | undefined): boolean => value !== undefined && value.trim() !== "";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/** Pure: everything is passed in, and only booleans and names come out. */
export function serverCheck(input: {
  env: Readonly<Record<string, string | undefined>>;
  platform: string;
  arch: string;
  hasKvm: boolean;
  catalog: { providers: readonly string[]; models: number; source: string };
  defaultModel: string;
}): ServerCheck {
  const { env } = input;
  const host = isSet(env.HOST) ? env.HOST?.trim() : undefined;
  const port = Number(env.PORT ?? 8787);
  const microvm =
    input.platform === "darwin"
      ? input.arch === "arm64"
        ? { available: true, detail: "Apple silicon Mac: the microVM sandbox can run." }
        : { available: false, detail: "Intel Macs can't run the microVM sandbox." }
      : input.platform === "linux"
        ? input.hasKvm
          ? { available: true, detail: "Linux with KVM: the microVM sandbox can run." }
          : { available: false, detail: "No /dev/kvm here, so the microVM sandbox can't start." }
        : {
            available: false,
            detail: "The microVM sandbox needs macOS on Apple silicon or Linux with KVM.",
          };
  return {
    keys: KEYS.map((key) => ({ ...key, set: key.names.every((name) => isSet(env[name])) })),
    models: {
      providers: [...input.catalog.providers],
      count: input.catalog.models,
      default: input.defaultModel,
      source: input.catalog.source,
    },
    microvm,
    listen: {
      port: Number.isFinite(port) ? port : 8787,
      scope:
        host === undefined || host === "::" || host === "0.0.0.0"
          ? "all"
          : LOOPBACK.has(host)
            ? "loopback"
            : "specific",
    },
  };
}

export async function serverCheckRoutes(args: RouteArgs): Promise<boolean> {
  if (args.path !== "/api/server/check" || args.req.method !== "GET") return false;
  const status = args.mind.models.status();
  args.json(
    200,
    serverCheck({
      env: process.env,
      platform: process.platform,
      arch: process.arch,
      hasKvm: process.platform === "linux" && existsSync("/dev/kvm"),
      catalog: status,
      defaultModel: args.mind.models.defaultRef(),
    }),
  );
  return true;
}
