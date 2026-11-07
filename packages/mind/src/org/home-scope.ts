/**
 * The home scope seam (phase 4 slice 2): one VM per home. The org and each
 * team get their own microVM; a bot's `bash` runs in its home's VM,
 * inside the bot's own folder. The scope dir is a stable string under the
 * artifacts root — `{root}/{owner}/_home/org` or `.../_home/team-<id>` —
 * that ext consumes verbatim (`sandboxNameOf` on it names the VM, keeping
 * the `ultiv-` prefix); ext never learns org concepts.
 *
 * Slice 2b rides the same seam: the resolver also hands ext the bot's own
 * Linux user (fixed uid from the `ultiv.bot-uids` ledger, the same uid in
 * every VM) so the VM provisions it at first use and runs every command as
 * it. A bot's `bash` runs ONLY in its home's VM — the home VM is the only VM
 * a bot ever uses (owner decision, 1 Nov 2026: no cross-home targeting, no
 * cross-home command execution), so retiring the user from that one VM is
 * the whole removal sweep.
 */
import { join } from "node:path";
import { rmSync } from "node:fs";
import { Effect } from "effect";
import type { HomeRef, ProfileInfo } from "@spriessen/contracts";
import { DEFAULT_TEAM_SHARED_CAP_BYTES, DEFAULT_ORG_SHARED_CAP_BYTES } from "@spriessen/contracts";
import {
  artifactsDir,
  botFolderName,
  destroySandbox,
  reconcileOrgVm,
  retireSandboxUser,
  sandboxNameOf,
  type HomeScope,
} from "@spriessen/ext";
import type { ConverseService } from "../converse/converse.ts";
import { botUidPeek, botUserOf, botUserName } from "./bot-users.ts";
import { readProfiles } from "../profiles/docs.ts";
import { homeOf } from "./model.ts";
import { readOrgState } from "./service.ts";

/** The stable scope dir naming one home's VM: {root}/{owner}/_home/{org|<teamId>}. */
export const homeScopeDir = (root: string, owner: string, home: HomeRef): string =>
  join(root, owner, "_home", home.kind === "org" ? "org" : home.teamId);

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
    profile: Pick<ProfileInfo, "id" | "teamId">,
  ): Promise<HomeScope | undefined> => {
    const state = await readOrgState(converse);
    if (state.org === null) return undefined;
    const home = homeOf(profile);
    const team =
      home.kind === "team" ? state.teams.find((row) => row.id === home.teamId) : undefined;
    const sharedGid = home.kind === "org" ? state.org.sharedGid : team?.sharedGid;
    // The home's network allowlist (slice 3): the org's for the org VM, the
    // team's for its VM — both defaulting to [] (fully offline). A
    // home with full network access (`netOpen`) ignores the list entirely.
    const netAllowlist =
      home.kind === "org" ? (state.org.netAllowlist ?? []) : (team?.netAllowlist ?? []);
    const netOpen = home.kind === "org" ? state.org.netOpen === true : team?.netOpen === true;
    // The home's stored VM size (slice 4): the cpus and memory its VM is
    // CREATED with — the org's or team's stored settings, defaults
    // 1 CPU / 512 MiB applied in ext when a legacy row has none.
    const vm = home.kind === "org" ? state.org.vm : team?.vm;
    const user = await botUserOf(converse)(root, owner, profile.id);
    // The org-wide folder (slice 2c): one host-side store per org, mounted
    // into EVERY VM — read-write in the org VM, read-only in a team
    // VM (enforced by the mount). Teams are a boundary again; this
    // folder and messaging are the only paths between homes.
    const orgShared = {
      hostDir: join(root, owner, "_shared", "org"),
      gid: state.org.orgSharedGid ?? 10_001,
      readOnly: home.kind === "team",
    };
    // The team's own durable store (slice 2d): backs BOTH its VM's
    // /home/shared and the org VM's /home/team-shared/<id>. One store, two
    // mounts, no copy.
    const teamStoreDir = (teamId: string): string => join(root, owner, "_team", teamId);
    const sharedStore = home.kind === "team" ? teamStoreDir(home.teamId) : undefined;
    // The org VM's team folders (slice 2d), ORG bots only: the parent
    // directory of every team store, the stored teams (a
    // create/delete reconciles /etc/group instead of restarting the VM),
    // and the org bots that already have a Linux user (never allocating —
    // a user is created at its bot's first use, never pre-created).
    let teamShared: HomeScope["teamShared"];
    if (home.kind === "org") {
      const profiles = await Effect.runPromise(readProfiles(converse));
      const orgBots = profiles.filter((row) => homeOf(row).kind === "org");
      const users: string[] = [];
      for (const bot of orgBots) {
        if ((await botUidPeek(converse)(bot.id)) !== undefined) {
          users.push(botUserName(bot.id));
        }
      }
      teamShared = {
        parentDir: join(root, owner, "_team"),
        teams: state.teams
          .filter((row) => row.sharedGid !== undefined)
          .map((row) => ({ id: row.id, gid: row.sharedGid as number })),
        users,
      };
    }
    // Shared-folder caps (fix 2), enforced at the tool path in ext: the
    // org-shared cap where it is writable, the team's own store cap,
    // and — org VM — every team store's cap.
    const caps: NonNullable<HomeScope["caps"]> = {
      orgShared: state.org.orgSharedCapBytes ?? DEFAULT_ORG_SHARED_CAP_BYTES,
      ...(team === undefined
        ? {}
        : { shared: team.sharedCapBytes ?? DEFAULT_TEAM_SHARED_CAP_BYTES }),
      ...(home.kind === "org"
        ? {
            team: Object.fromEntries(
              state.teams.map((row) => [
                row.id,
                row.sharedCapBytes ?? DEFAULT_TEAM_SHARED_CAP_BYTES,
              ]),
            ),
          }
        : {}),
    };
    return {
      dir: homeScopeDir(root, owner, home),
      caps,
      ...(sharedGid === undefined ? {} : { sharedGid }),
      orgShared,
      ...(sharedStore === undefined ? {} : { sharedStore }),
      ...(teamShared === undefined ? {} : { teamShared }),
      user,
      netAllowlist,
      netOpen,
      ...(vm === undefined ? {} : { vm }),
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

/**
 * The default team-group reconciliation (slice 2d): run ext's
 * reconcile script inside the RUNNING org VM. A stopped VM is skipped — its
 * next boot reconciles from the stored teams anyway. Best effort,
 * never throws.
 */
export const defaultReconcileTeamGroups = (): ((
  owner: string,
  script: string,
) => Promise<void>) => {
  const root = artifactsDir();
  return async (owner, script) => {
    await reconcileOrgVm(sandboxNameOf(homeScopeDir(root, owner, { kind: "org" })), script);
  };
};

/**
 * The default team-store deletion (slice 2d, F-D9 default): the
 * store is deleted with the team's purge. Best effort; archiving is
 * not decided.
 */
export const defaultDeleteTeamStore = (): ((owner: string, teamId: string) => Promise<void>) => {
  const root = artifactsDir();
  return (owner, teamId) => {
    rmSync(join(root, owner, "_team", teamId), { recursive: true, force: true });
    return Promise.resolve();
  };
};
