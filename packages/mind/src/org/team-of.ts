/**
 * Which team a bot belongs to, and the team Instructions it
 * inherits — the resolvers the identity section and the home rules read.
 */

import { Effect } from "effect";
import type { ConverseService } from "../converse/converse.ts";
import { readProfiles } from "../profiles/docs.ts";
import { readOrgState } from "./service.ts";

/**
 * The team Instructions text a profile inherits (empty for an org
 * bot): the resolver the identity section renders before the bot's own.
 */
export const teamInstructionsOf =
  (converse: ConverseService) =>
  async (profile: { readonly teamId?: string | null }): Promise<string> => {
    if (typeof profile.teamId !== "string" || profile.teamId === "") return "";
    const state = await readOrgState(converse);
    return state.teams.find((row) => row.id === profile.teamId)?.instructions ?? "";
  };

/** The team a bot belongs to (null for an org bot); by profile row. */
export const teamOfProfileRow =
  (_converse: ConverseService) =>
  async (profile: { readonly teamId?: string | null }): Promise<string | null> =>
    typeof profile.teamId === "string" && profile.teamId !== "" ? profile.teamId : null;

/** The team a bot belongs to (null for an org bot); by profile id. */
export const teamOfProfile =
  (converse: ConverseService) =>
  async (profileId: string): Promise<string | null> => {
    const profiles = await Effect.runPromise(readProfiles(converse));
    const row = profiles.find((candidate) => candidate.id === profileId);
    return row === undefined ? null : teamOfProfileRow(converse)(row);
  };
