/**
 * The Org service: reads and writes the `ultiv.org` document. Departments,
 * members, grants and templates live here; bots stay in the profiles
 * registry and point at a department with `departmentId`. Everything goes
 * through one commit helper so a change lands as one transaction.
 */
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { InvalidInput, NotFound, Unavailable } from "@spriessen/core";
import type {
  DepartmentCreate,
  DepartmentInfo,
  DepartmentPatch,
  GrantInfo,
  HomeRef,
  MemberInfo,
  MemberPut,
  OrgInfo,
  OrgState,
  TemplateInfo,
} from "@spriessen/contracts";
import type { ConverseService } from "../converse/converse.ts";
import { readProfiles } from "../profiles/docs.ts";
import { OrgDoc, defaultVm, emptyOrgState, normalizeOrgState } from "./model.ts";

const run = <A>(effect: Effect.Effect<A, unknown>): Promise<A> =>
  Effect.runPromise(effect) as Promise<A>;

/** The whole org state, normalized (missing fields filled, never overwritten). */
export const readOrgState = (converse: ConverseService): Promise<OrgState> =>
  run(
    Effect.map(converse.docs.snapshot(OrgDoc), (doc) => normalizeOrgState(doc ?? emptyOrgState())),
  );

/** Commit one change to the org document. */
export const commitOrg = (
  converse: ConverseService,
  change: (draft: OrgState) => void,
): Promise<void> =>
  run(
    converse.docs.commit(async (tx) => {
      const draft = await tx.doc(OrgDoc);
      // Mutate the draft in place; a copy would die with the transaction.
      change(draft as OrgState);
    }),
  );

export interface OrgView {
  readonly org: OrgInfo | null;
  readonly departments: readonly DepartmentInfo[];
  readonly members: readonly MemberInfo[];
  readonly grants: readonly GrantInfo[];
  readonly templates: readonly TemplateInfo[];
}

export interface OrgService {
  /** The current state (org null on a fresh install, before the migration). */
  readonly view: () => Promise<OrgView>;
  /** Create the org once (the migration); repeat calls change nothing. */
  readonly ensureOrg: (owner: string, name: string, hostAccess: boolean) => Promise<OrgInfo>;
  readonly createDepartment: (input: DepartmentCreate, by: string) => Promise<DepartmentInfo>;
  readonly updateDepartment: (id: string, patch: DepartmentPatch) => Promise<DepartmentInfo>;
  /** Refuses while the department still has bots (move or delete them first). */
  readonly removeDepartment: (id: string) => Promise<boolean>;
  /** Set (or replace) one membership row; org owner and org admins manage these. */
  readonly setMember: (input: MemberPut) => Promise<MemberInfo[]>;
  readonly removeMember: (accountId: string, departmentId: string | null) => Promise<boolean>;
  readonly addGrant: (
    resource: GrantInfo["resource"],
    grantee: HomeRef,
    by: string,
  ) => Promise<GrantInfo>;
  readonly revokeGrant: (id: string) => Promise<boolean>;
  readonly activeGrants: () => Promise<readonly GrantInfo[]>;
  readonly putTemplate: (template: TemplateInfo) => Promise<TemplateInfo>;
  readonly removeTemplate: (id: string) => Promise<boolean>;
}

/** The department a HomeRef names, or null for the org. */
const departmentOfHome = (home: HomeRef): string | null =>
  home.kind === "department" ? home.departmentId : null;

/** A department id that is not in use; `name` is unique among departments. */
const departmentId = (name: string): string =>
  `dept-${
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 24) || randomUUID().slice(0, 8)
  }`;

export const orgService = (converse: ConverseService): OrgService => {
  const view = async (): Promise<OrgView> => {
    const state = await readOrgState(converse);
    return {
      org: state.org,
      departments: state.departments,
      members: state.members,
      grants: state.grants,
      templates: state.templates,
    };
  };
  return {
    view,
    ensureOrg: async (owner, name, hostAccess) => {
      const state = await readOrgState(converse);
      if (state.org !== null) return state.org;
      const org: OrgInfo = {
        id: "org",
        name,
        owner,
        createdAt: Date.now(),
        vm: defaultVm(),
        hostAccess,
      };
      const member: MemberInfo = { accountId: owner, role: "owner", departmentId: null };
      await commitOrg(converse, (draft) => {
        if (draft.org !== null) return;
        draft.org = org;
        draft.members = [...draft.members, member];
      });
      return org;
    },
    createDepartment: async (input, _by) => {
      const state = await readOrgState(converse);
      if (state.org === null)
        throw new Unavailable({ faculty: "org", why: "the org does not exist yet" });
      if (state.departments.some((row) => row.name === input.name)) {
        throw new InvalidInput({ reason: "a department with this name already exists" });
      }
      const row: DepartmentInfo = {
        id: departmentId(input.name),
        name: input.name,
        createdAt: Date.now(),
        vm: input.vm ?? defaultVm(),
        hostAccess: input.hostAccess ?? false,
        instructions: input.instructions ?? "",
      };
      await commitOrg(converse, (draft) => {
        draft.departments = [...draft.departments, row];
      });
      return row;
    },
    updateDepartment: async (id, patch) => {
      let updated: DepartmentInfo | undefined;
      await commitOrg(converse, (draft) => {
        draft.departments = draft.departments.map((row) => {
          if (row.id !== id) return row;
          updated = {
            ...row,
            vm: { ...row.vm },
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.vm !== undefined ? { vm: { ...patch.vm } } : {}),
            ...(patch.hostAccess !== undefined ? { hostAccess: patch.hostAccess } : {}),
            ...(patch.instructions !== undefined ? { instructions: patch.instructions } : {}),
          };
          return updated;
        });
      });
      if (updated === undefined) throw new NotFound({ what: `department ${id}` });
      // A plain copy: draft values die with the transaction.
      return updated;
    },
    removeDepartment: async (id) => {
      const state = await readOrgState(converse);
      if (!state.departments.some((row) => row.id === id)) return false;
      const profiles = await run(readProfiles(converse));
      if (profiles.some((profile) => profile.departmentId === id)) {
        throw new InvalidInput({ reason: "the department still has bots" });
      }
      await commitOrg(converse, (draft) => {
        draft.departments = draft.departments.filter((row) => row.id !== id);
        draft.members = draft.members.filter((member) => member.departmentId !== id);
        draft.grants = draft.grants.filter(
          (grant) =>
            departmentOfHome(grant.resource.home) !== id && departmentOfHome(grant.grantee) !== id,
        );
      });
      return true;
    },
    setMember: async (input) => {
      await commitOrg(converse, (draft) => {
        const rest = draft.members.filter(
          (member) =>
            !(member.accountId === input.accountId && member.departmentId === input.departmentId),
        );
        draft.members = [...rest, input];
      });
      return (await readOrgState(converse)).members;
    },
    removeMember: async (accountId, departmentId) => {
      const before = await readOrgState(converse);
      if (
        !before.members.some(
          (member) => member.accountId === accountId && member.departmentId === departmentId,
        )
      ) {
        return false;
      }
      await commitOrg(converse, (draft) => {
        draft.members = draft.members.filter(
          (member) => !(member.accountId === accountId && member.departmentId === departmentId),
        );
      });
      return true;
    },
    addGrant: async (resource, grantee, by) => {
      const grant: GrantInfo = {
        id: randomUUID(),
        resource,
        grantee,
        action: "use",
        createdAt: Date.now(),
        createdBy: by,
        revokedAt: null,
      };
      await commitOrg(converse, (draft) => {
        draft.grants = [...draft.grants, grant];
      });
      return grant;
    },
    revokeGrant: async (id) => {
      const state = await readOrgState(converse);
      const grant = state.grants.find((row) => row.id === id && row.revokedAt === null);
      if (grant === undefined) return false;
      await commitOrg(converse, (draft) => {
        draft.grants = draft.grants.map((row) =>
          row.id === id && row.revokedAt === null ? { ...row, revokedAt: Date.now() } : row,
        );
      });
      return true;
    },
    activeGrants: async () =>
      (await readOrgState(converse)).grants.filter((grant) => grant.revokedAt === null),
    putTemplate: async (template) => {
      await commitOrg(converse, (draft) => {
        draft.templates = [...draft.templates.filter((row) => row.id !== template.id), template];
      });
      return template;
    },
    removeTemplate: async (id) => {
      const state = await readOrgState(converse);
      if (!state.templates.some((row) => row.id === id)) return false;
      await commitOrg(converse, (draft) => {
        draft.templates = draft.templates.filter((row) => row.id !== id);
      });
      return true;
    },
  };
};

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
