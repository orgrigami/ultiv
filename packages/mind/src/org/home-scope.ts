/**
 * The home scope seam (phase 4 slice 2): one VM per home. The org and each
 * department get their own microVM; a bot's `bash` runs in its home's VM,
 * inside the bot's own folder. The scope dir is a stable string under the
 * artifacts root — `{root}/{owner}/_home/org` or `.../_home/dept-<id>` —
 * that ext consumes verbatim (`sandboxNameOf` on it names the VM, keeping
 * the `ultiv-` prefix); ext never learns org concepts.
 *
 * Slice 2b rides the same seam: the resolver also hands ext the bot's own
 * Linux user (fixed uid from the `ultiv.bot-uids` ledger, the same uid in
 * every VM) so the VM provisions it at first use and runs every command as
 * it. Removing a bot retires that user from its home's VM — the only VM a
 * bot uses until slice 2c adds cross-VM targets.
 */
import { join } from "node:path";
import type { HomeRef, ProfileInfo } from "@spriessen/contracts";
import {
  artifactsDir,
  botFolderName,
  destroySandbox,
  retireSandboxUser,
  sandboxNameOf,
  type HomeScope,
} from "@spriessen/ext";
import type { ConverseService } from "../converse/converse.ts";
import { botUidPeek, botUserOf, botUserName } from "./bot-users.ts";
import { homeOf } from "./model.ts";
import { readOrgState } from "./service.ts";

/** The stable scope dir naming one home's VM: {root}/{owner}/_home/{org|<departmentId>}. */
export const homeScopeDir = (root: string, owner: string, home: HomeRef): string =>
  join(root, owner, "_home", home.kind === "org" ? "org" : home.departmentId);

/**
 * The home scope of one bot: its home's scope dir, the home's shared-folder
 * gid, and the bot's own Linux user (its uid is allocated at this first
 * use). Undefined before the org exists (a pre-migration install keeps the
 * per-bot VMs of older embedders).
 */
export const homeScopeOfProfile =
  (converse: ConverseService, root: string) =>
  async (
    owner: string,
    profile: Pick<ProfileInfo, "id" | "departmentId">,
  ): Promise<HomeScope | undefined> => {
    const state = await readOrgState(converse);
    if (state.org === null) return undefined;
    const home = homeOf(profile);
    const sharedGid =
      home.kind === "org"
        ? state.org.sharedGid
        : state.departments.find((row) => row.id === home.departmentId)?.sharedGid;
    const user = await botUserOf(converse)(root, owner, profile.id);
    return {
      dir: homeScopeDir(root, owner, home),
      ...(sharedGid === undefined ? {} : { sharedGid }),
      user,
    };
  };

/**
 * The default home-VM teardown: stop, then remove, the home's VM — best
 * effort (a missing VM or a stuck runtime never fails the removal) and
 * bounded at 8 s. `openMind`'s `destroyHomeVm` defaults to this; tests
 * inject a recorder so no VM runtime is touched.
 */
export const defaultDestroyHomeVm = (): ((owner: string, home: HomeRef) => Promise<void>) => {
  const root = artifactsDir();
  return async (owner, home) => {
    const name = sandboxNameOf(homeScopeDir(root, owner, home));
    await Promise.race([
      destroySandbox(name).then(
        () => true,
        () => false,
      ),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 8_000)),
    ]);
  };
};

/**
 * The default bot-user teardown (slice 2b): retire the removed bot's Linux
 * user — and with it its shared-folder group membership — from its home's
 * VM, immediately when the VM is running, otherwise marked for its next
 * boot (ext keeps a pending-removal file per VM). Best effort: a bot that
 * never ran `bash` has no uid and nothing to retire, and a missing VM or a
 * down runtime never fails the purge. `openMind`'s `retireBotUser` defaults
 * to this; tests inject a recorder.
 */
export const defaultRetireBotUser =
  (converse: ConverseService) =>
  async (owner: string, home: HomeRef, profileId: string): Promise<void> => {
    const uid = await botUidPeek(converse)(profileId);
    if (uid === undefined) return;
    const root = artifactsDir();
    await retireSandboxUser(sandboxNameOf(homeScopeDir(root, owner, home)), {
      name: botUserName(profileId),
      home: `/home/${botFolderName(`${root}/${owner}/${profileId}`)}`,
    });
  };
