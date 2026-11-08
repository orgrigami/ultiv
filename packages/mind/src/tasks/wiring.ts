/**
 * What the tasks faculty needs from the rest of the mind once it exists:
 * each bot's running limit (its policy, else the workspace default), the
 * files a task's conversation wrote (for the parent's wake), and the
 * work-tree stop extras (mailbox settlement, background-job kills).
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
  profiles: Pick<ProfilesService, "get" | "workspaceTaskLimit" | "workspacePaused">,
  holder: ScopeHolder | undefined,
  extras: {
    /** Settle pending mail sent FROM stopped conversations (stop propagation). */
    readonly cancelMailSentFrom?: (conversations: readonly string[]) => Promise<number>;
    /** Kill background bash jobs running in stopped conversations. */
    readonly stopJobsOf?: (conversations: readonly string[]) => Promise<number>;
  } = {},
  root: string = artifactsDir(),
): TaskWiring => ({
  limitOf: async (bot) => {
    const stored = await profiles.workspaceTaskLimit().catch(() => null);
    if (bot === null) return taskLimitOf(null, stored);
    const profile = await profiles.get(bot.owner, bot.profileId).catch(() => undefined);
    return taskLimitOf(profile?.policies.maxRunningTasks, stored);
  },
  isPaused: async () => await profiles.workspacePaused().catch(() => false),
  filesOf: async (conversationId, since) => {
    const dir = holder === undefined ? root : scopeDir(holder, conversationId, root);
    return searchArtifacts(dir, { conversationId })
      .filter((info) => touchedAt(info) >= since)
      .map((info) => ({ id: info.id, name: info.name }));
  },
  ...(extras.cancelMailSentFrom !== undefined
    ? { cancelMailSentFrom: extras.cancelMailSentFrom }
    : {}),
  ...(extras.stopJobsOf !== undefined ? { stopJobsOf: extras.stopJobsOf } : {}),
});
