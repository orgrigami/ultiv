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
 * it. A bot's `bash` runs ONLY in its home's VM — the home VM is the only VM
 * a bot ever uses (owner decision, 1 Nov 2026: no cross-home targeting, no
 * cross-home command execution), so retiring the user from that one VM is
 * the whole removal sweep.
 */
import { join } from "node:path";
import { rmSync } from "node:fs";
import { Effect } from "effect";
import type { HomeRef, ProfileInfo } from "@spriessen/contracts";
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
    const department =
      home.kind === "department"
        ? state.departments.find((row) => row.id === home.departmentId)
        : undefined;
    const sharedGid = home.kind === "org" ? state.org.sharedGid : department?.sharedGid;
    // The home's network allowlist (slice 3): the org's for the org VM, the
    // department's for its VM — both defaulting to [] (fully offline).
    const netAllowlist =
      home.kind === "org" ? (state.org.netAllowlist ?? []) : (department?.netAllowlist ?? []);
    const user = await botUserOf(converse)(root, owner, profile.id);
    // The org-wide folder (slice 2c): one host-side store per org, mounted
    // into EVERY VM — read-write in the org VM, read-only in a department
    // VM (enforced by the mount). Departments are a boundary again; this
    // folder and messaging are the only paths between homes.
    const orgShared = {
      hostDir: join(root, owner, "_shared", "org"),
      gid: state.org.orgSharedGid ?? 10_001,
      readOnly: home.kind === "department",
    };
    // The department's own durable store (slice 2d): backs BOTH its VM's
    // /home/shared and the org VM's /home/dept-shared/<id>. One store, two
    // mounts, no copy.
    const deptStoreDir = (departmentId: string): string => join(root, owner, "_dept", departmentId);
    const sharedStore = home.kind === "department" ? deptStoreDir(home.departmentId) : undefined;
    // The org VM's department folders (slice 2d), ORG bots only: the parent
    // directory of every department store, the stored departments (a
    // create/delete reconciles /etc/group instead of restarting the VM),
    // and the org bots that already have a Linux user (never allocating —
    // a user is created at its bot's first use, never pre-created).
    let deptShared: HomeScope["deptShared"];
    if (home.kind === "org") {
      const profiles = await Effect.runPromise(readProfiles(converse));
      const orgBots = profiles.filter((row) => homeOf(row).kind === "org");
      const users: string[] = [];
      for (const bot of orgBots) {
        if ((await botUidPeek(converse)(bot.id)) !== undefined) {
          users.push(botUserName(bot.id));
        }
      }
      deptShared = {
        parentDir: join(root, owner, "_dept"),
        depts: state.departments
          .filter((row) => row.sharedGid !== undefined)
          .map((row) => ({ id: row.id, gid: row.sharedGid as number })),
        users,
      };
    }
    return {
      dir: homeScopeDir(root, owner, home),
      ...(sharedGid === undefined ? {} : { sharedGid }),
      orgShared,
      ...(sharedStore === undefined ? {} : { sharedStore }),
      ...(deptShared === undefined ? {} : { deptShared }),
      user,
      netAllowlist,
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
 * The default department-group reconciliation (slice 2d): run ext's
 * reconcile script inside the RUNNING org VM. A stopped VM is skipped — its
 * next boot reconciles from the stored departments anyway. Best effort,
 * never throws.
 */
export const defaultReconcileDeptGroups = (): ((
  owner: string,
  script: string,
) => Promise<void>) => {
  const root = artifactsDir();
  return async (owner, script) => {
    await reconcileOrgVm(sandboxNameOf(homeScopeDir(root, owner, { kind: "org" })), script);
  };
};

/**
 * The default department-store deletion (slice 2d, F-D9 default): the
 * store is deleted with the department's purge. Best effort; archiving is
 * not decided.
 */
export const defaultDeleteDeptStore = (): ((
  owner: string,
  departmentId: string,
) => Promise<void>) => {
  const root = artifactsDir();
  return (owner, departmentId) => {
    rmSync(join(root, owner, "_dept", departmentId), { recursive: true, force: true });
    return Promise.resolve();
  };
};
