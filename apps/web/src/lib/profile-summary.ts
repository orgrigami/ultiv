/**
 * The counts on a bot's profile tabs and the one-liners on its overview
 * cards. Pure, so the wording is tested; the route fetches the numbers.
 */
import type { ProfileApprovalMode } from "@spriessen/contracts";
import { MODE_CHIP } from "./approval-mode.ts";

/** What the profile knows about one bot. `undefined` = not loaded (or failed). */
export interface ProfileCounts {
  memory?: number | undefined;
  routines?: number | undefined;
  files?: number | undefined;
  /** Saved versions across Persona and Instructions. */
  versions?: number | undefined;
  /** Activity lines loaded (the tab shows the newest ACTIVITY_LIMIT). */
  activity?: number | undefined;
  /** Saved behaviour tests. */
  tests?: number | undefined;
  /** Open (active or paused) projects. */
  projects?: number | undefined;
}

/** How many activity lines the tab loads, so the count says "50+" past it. */
export const ACTIVITY_LIMIT = 50;

export interface ProfileFacts {
  policies: { approvalMode: ProfileApprovalMode };
  /** null = every tool. */
  toolAllowlist: readonly string[] | null;
}

/**
 * The count on a tab, or none while it is loading. Every tab but Overview
 * has one; Overview is the index of the others, so it carries none. Access
 * counts allowed tools, or "All" when the list isn't narrowed; Activity
 * stops at ACTIVITY_LIMIT and shows "50+" there.
 */
export function tabCount(
  tab: string,
  counts: ProfileCounts,
  bot: ProfileFacts,
): number | string | undefined {
  if (tab === "instructions") return counts.versions;
  if (tab === "memory") return counts.memory;
  if (tab === "routines") return counts.routines;
  if (tab === "files") return counts.files;
  if (tab === "tests") return counts.tests;
  if (tab === "projects") return counts.projects;
  if (tab === "access") return bot.toolAllowlist === null ? "All" : bot.toolAllowlist.length;
  if (tab === "activity")
    return counts.activity !== undefined && counts.activity >= ACTIVITY_LIMIT
      ? `${ACTIVITY_LIMIT}+`
      : counts.activity;
  return undefined;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** One plain line per overview card. */
export function cardLine(tab: string, counts: ProfileCounts, bot: ProfileFacts): string {
  switch (tab) {
    case "memory":
      return counts.memory === undefined
        ? "What it remembers about you"
        : counts.memory === 0
          ? "Nothing remembered yet"
          : `${plural(counts.memory, "fact", "facts")} it keeps about you`;
    case "routines":
      return counts.routines === undefined
        ? "Schedules, webhooks and sensors"
        : counts.routines === 0
          ? "Nothing scheduled yet"
          : `${plural(counts.routines, "routine", "routines")} on a schedule or trigger`;
    case "access": {
      const tools =
        bot.toolAllowlist === null
          ? "every tool"
          : bot.toolAllowlist.length === 0
            ? "no tools"
            : plural(bot.toolAllowlist.length, "tool", "tools");
      return `${MODE_CHIP[bot.policies.approvalMode].label} approvals · ${tools}`;
    }
    case "files":
      return counts.files === undefined
        ? "Files it made or you shared"
        : counts.files === 0
          ? "No files yet"
          : `${plural(counts.files, "file", "files")} it made or you shared`;
    case "instructions":
      return counts.versions === undefined
        ? "Its persona and standing instructions"
        : `Persona and instructions · ${plural(counts.versions, "version", "versions")} saved`;
    case "activity":
      return "What it did, newest first";
    case "projects":
      return counts.projects === undefined
        ? "Goals it works toward over days"
        : counts.projects === 0
          ? "No open goals"
          : `${plural(counts.projects, "open goal", "open goals")}`;
    case "tests":
      return counts.tests === undefined
        ? "Saved messages replayed to catch regressions"
        : counts.tests === 0
          ? "No tests yet"
          : `${plural(counts.tests, "test", "tests")} to replay after a change`;
    default:
      return "";
  }
}
