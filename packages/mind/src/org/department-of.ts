/**
 * Which department a bot belongs to, and the department Instructions it
 * inherits — the resolvers the identity section and the home rules read.
 */

import { Effect } from "effect";
import type { ConverseService } from "../converse/converse.ts";
import { readProfiles } from "../profiles/docs.ts";
import { readOrgState } from "./service.ts";

/**
 * The department Instructions text a profile inherits (empty for an org
 * bot): the resolver the identity section renders before the bot's own.
 */
export const departmentInstructionsOf =
  (converse: ConverseService) =>
  async (profile: { readonly departmentId?: string | null }): Promise<string> => {
    if (typeof profile.departmentId !== "string" || profile.departmentId === "") return "";
    const state = await readOrgState(converse);
    return state.departments.find((row) => row.id === profile.departmentId)?.instructions ?? "";
  };

/** The department a bot belongs to (null for an org bot); by profile row. */
export const departmentOfProfileRow =
  (_converse: ConverseService) =>
  async (profile: { readonly departmentId?: string | null }): Promise<string | null> =>
    typeof profile.departmentId === "string" && profile.departmentId !== ""
      ? profile.departmentId
      : null;

/** The department a bot belongs to (null for an org bot); by profile id. */
export const departmentOfProfile =
  (converse: ConverseService) =>
  async (profileId: string): Promise<string | null> => {
    const profiles = await Effect.runPromise(readProfiles(converse));
    const row = profiles.find((candidate) => candidate.id === profileId);
    return row === undefined ? null : departmentOfProfileRow(converse)(row);
  };
