/**
 * The home invariants around the main bot: the main bot is an org bot
 * (its home is the org, never a team), and the org always keeps at
 * least one active bot. One pure check, asked by every write that could
 * break either (create, move, archive, remove, set main) — the REST routes
 * and the main bot's tools both reach it through the profiles service.
 */
import type { ProfileInfo } from "@spriessen/contracts";

type Row = Pick<ProfileInfo, "id" | "owner" | "teamId" | "archivedAt">;

export type HomeChange =
  | { readonly kind: "create"; readonly to: string | null }
  | { readonly kind: "move"; readonly id: string; readonly to: string | null }
  | { readonly kind: "archive"; readonly id: string }
  | { readonly kind: "remove"; readonly id: string }
  | { readonly kind: "set-main"; readonly id: string };

const inOrg = (row: Pick<Row, "teamId">): boolean =>
  row.teamId === null || row.teamId === undefined || row.teamId === "";

/** Why this change would break a home invariant, in words the owner can act on; null when fine. */
export const homeRuleProblem = (
  rows: readonly Row[],
  owner: string,
  mainId: string | null,
  change: HomeChange,
): string | null => {
  const mine = rows.filter((row) => row.owner === owner);
  const orgBots = mine.filter((row) => inOrg(row) && row.archivedAt === null);
  const lastOrgBot = (id: string): boolean => orgBots.length === 1 && orgBots[0]?.id === id;
  switch (change.kind) {
    case "create":
      return change.to !== null && orgBots.length === 0
        ? "the first bot lives in the org (it becomes the main bot); create it without a team"
        : null;
    case "move":
      if (change.to === null) return null;
      if (change.id === mainId) {
        return "the main bot lives in the org; make another org bot the main bot before moving this one";
      }
      return lastOrgBot(change.id)
        ? "the org must keep at least one bot; add or move another bot to the org first"
        : null;
    case "archive":
    case "remove":
      if (change.id === mainId) {
        return `the main bot cannot be ${change.kind === "archive" ? "paused" : "removed"}; make another org bot the main bot first`;
      }
      return lastOrgBot(change.id)
        ? `the org must keep at least one bot; this is its last one, so it cannot be ${change.kind === "archive" ? "paused" : "removed"}`
        : null;
    case "set-main": {
      const row = mine.find((entry) => entry.id === change.id);
      if (row === undefined) return null;
      return inOrg(row)
        ? null
        : "the main bot must be an org bot; move this bot to the org first, then make it main";
    }
  }
};
