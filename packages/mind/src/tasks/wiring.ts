/**
 * What the tasks faculty needs from the rest of the mind once it exists:
 * each bot's running limit (its policy, else the workspace default) and the
 * files a task's conversation wrote, for the parent's wake.
 */
import {
  artifactsDir,
  scopeDir,
  searchArtifacts,
  touchedAt,
  type ScopeHolder,
} from "@spriessen/ext";
import type { ProfilesService } from "../profiles/profiles.ts";
import { taskLimitOf } from "./limits.ts";
import type { TaskWiring } from "./run.ts";

export const taskWiring = (
  profiles: Pick<ProfilesService, "get" | "workspaceTaskLimit">,
  holder: ScopeHolder | undefined,
  root: string = artifactsDir(),
): TaskWiring => ({
  limitOf: async (bot) => {
    const stored = await profiles.workspaceTaskLimit().catch(() => null);
    if (bot === null) return taskLimitOf(null, stored);
    const profile = await profiles.get(bot.owner, bot.profileId).catch(() => undefined);
    return taskLimitOf(profile?.policies.maxRunningTasks, stored);
  },
  filesOf: async (conversationId, since) => {
    const dir = holder === undefined ? root : scopeDir(holder, conversationId, root);
    return searchArtifacts(dir, { conversationId })
      .filter((info) => touchedAt(info) >= since)
      .map((info) => ({ id: info.id, name: info.name }));
  },
});
