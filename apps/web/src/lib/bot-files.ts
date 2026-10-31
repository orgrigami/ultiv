/**
 * A bot's Persona and Instructions on the profile page (docs/BOT-FILES.md):
 * the shapes the REST routes return and the plain words shown beside each
 * version. Pure, so the wording is tested from the root suite.
 */
import { formatWhen } from "./format.ts";

export type BotFileName = "persona" | "instructions";

export interface BotFileState {
  text: string;
  version: number;
}

export interface BotFileVersion {
  n: number;
  text: string;
  at: number;
  by: "owner" | "bot" | "migration" | "learning";
  reason: string;
  turn?: string;
  restoredFrom?: number;
}

export const BOT_FILE_META: Record<
  BotFileName,
  { label: string; help: string; limit: number; empty: string }
> = {
  persona: {
    label: "Persona",
    help: "Who the bot is: identity, tone and style.",
    limit: 8_000,
    empty: "No persona yet.",
  },
  instructions: {
    label: "Instructions",
    help: "What it does: rules, workflows and when to ask first. Approval rules still win.",
    limit: 16_000,
    empty: "No instructions yet.",
  },
};

const WHO: Record<BotFileVersion["by"], string> = {
  owner: "you",
  bot: "the bot",
  migration: "the upgrade",
  learning: "learning",
};

/** "v3 · you · 2 Nov, 10:04 · Restored version 1". */
export function versionLine(version: BotFileVersion, now: Date = new Date()): string {
  return [`v${version.n}`, WHO[version.by], formatWhen(version.at, now), version.reason].join(
    " · ",
  );
}

/** Save is offered only for a real change within the limit. */
export function saveProblem(file: BotFileName, draft: string, saved: string): string | null {
  if (draft.length > BOT_FILE_META[file].limit)
    return `${BOT_FILE_META[file].label} can be at most ${BOT_FILE_META[file].limit} characters.`;
  return draft === saved ? "" : null;
}
