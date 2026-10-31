/**
 * The counts on a bot's profile tabs and the one-liners on its overview
 * cards. Pure, so the wording is tested; the route fetches the numbers.
 */
import type { ProfileApprovalMode } from "@spreissen/contracts";
import { MODE_CHIP } from "./approval-mode.ts";

/** What the profile knows about one bot. `undefined` = not loaded (or failed). */
export interface ProfileCounts {
  memory?: number | undefined;
  routines?: number | undefined;
  files?: number | undefined;
}

export interface ProfileFacts {
  policies: { approvalMode: ProfileApprovalMode };
  /** null = every tool. */
  toolAllowlist: readonly string[] | null;
}

/** The number on a tab, or none. Access counts tools only when the list is narrowed. */
export function tabCount(
  tab: string,
  counts: ProfileCounts,
  bot: ProfileFacts,
): number | undefined {
  if (tab === "memory") return counts.memory;
  if (tab === "routines") return counts.routines;
  if (tab === "files") return counts.files;
  if (tab === "access") return bot.toolAllowlist?.length;
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
    case "activity":
      return "What it did, newest first";
    default:
      return "";
  }
}
