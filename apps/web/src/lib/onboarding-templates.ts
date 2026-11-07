/**
 * The first-run templates, worded by what THIS server can do. A promise a
 * template makes is either ready (a check) or names what it still needs
 * (the key, by name only — never a value), so a new owner never meets a bot
 * that claims web search it cannot run. Readiness comes from
 * GET /api/server/check; until it answers (or if it fails) the plain wording
 * shows, and a check that answers corrects it.
 */
import type { ServerCheck } from "@/lib/api-types";

export interface Readiness {
  readonly webSearch: boolean;
  readonly vault: boolean;
  readonly sandbox: boolean;
}

export interface Bullet {
  readonly text: string;
  /** false: the capability is not set up here; `need` says what turns it on. */
  readonly ready: boolean;
  readonly need?: string;
}

export interface Template {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly persona: string;
  readonly bullets: readonly Bullet[];
}

const keySet = (check: ServerCheck, name: string): boolean =>
  check.keys.some((key) => key.names.includes(name) && key.set);

export const readinessOf = (check: ServerCheck): Readiness => ({
  webSearch: keySet(check, "TINYFISH_API_KEY"),
  vault: keySet(check, "VAULT_KEY"),
  sandbox: check.microvm.available,
});

const ready = (text: string): Bullet => ({ text, ready: true });

/** A capability bullet: ready, missing (with its fix), or neutral while unknown. */
const gated = (on: boolean | undefined, text: string, offText: string, need: string): Bullet =>
  on === false ? { text: offText, ready: false, need } : ready(text);

/** Onboarding only shows with no bots, so "other bots" is always a later step. */
export const templatesFor = (readiness: Readiness | null): Template[] => [
  {
    key: "assistant",
    name: "Assistant",
    description: "Everyday questions, drafts, and small tasks",
    persona:
      "You are a concise, proactive assistant. When a request is ambiguous you ask one clarifying question, then act. You keep answers short unless depth is asked for, and you say so plainly when you are unsure.",
    bullets: [
      ready("Chats, plans, and drafts"),
      ready("Remembers what matters across chats"),
      gated(
        readiness?.vault,
        "Uses logins you save in the vault, only on sites you allow",
        "Can't use saved logins here yet",
        "VAULT_KEY on the server",
      ),
      gated(
        readiness?.sandbox,
        "Runs scripts in its own sandboxed computer",
        "No sandboxed computer on this machine, so no shell",
        "macOS on Apple silicon, or Linux with KVM",
      ),
    ],
  },
  {
    key: "researcher",
    name: "Researcher",
    description: "Deep dives that end in a written-up source list",
    persona:
      "You are a meticulous researcher. You search before you claim, name where each fact came from, and separate findings from inference. You finish with a structured summary and save long write-ups as artifacts. When you cannot search the web, you say so and work from what the owner gives you.",
    bullets: [
      gated(
        readiness?.webSearch,
        "Searches the live web and reads pages",
        "No live web search here: works from what you paste",
        "TINYFISH_API_KEY on the server",
      ),
      ready("Names its sources and separates fact from guess"),
      ready("Saves findings as files"),
    ],
  },
  {
    key: "projects",
    name: "Projects",
    description: "Keeps goals moving: milestones, next steps, status",
    persona:
      "You are a project coordinator. You track each goal as a project with milestones, break work into small next steps, record what is done versus blocked, and surface blockers early. You write statuses anyone can skim in ten seconds.",
    bullets: [
      ready("Tracks goals as projects with milestones"),
      ready("Breaks work into next steps and reports status"),
      { text: "Coordinates with other bots once you add some", ready: false },
    ],
  },
];
