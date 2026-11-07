/**
 * Projects, stored in one `ultiv.projects` doc and read per owner and bot.
 * Every change goes through the rules (rules.ts) inside one commit and
 * tells listeners (the app's live signal). Another owner's project reads
 * as missing.
 */
import { randomUUID } from "node:crypto";
import { defineDoc } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import type { ProjectInfo } from "@spriessen/contracts";
import type { ConverseService } from "../converse/converse.ts";
import { changeProject, isOpen, startProject, type Outcome, type ProjectChange } from "./rules.ts";

export const ProjectsDoc = defineDoc<{ projects: ProjectInfo[] }>({
  kind: "ultiv.projects",
  version: 1,
  scope: "session",
  initial: () => ({ projects: [] }),
  checkpointWhen: () => true,
});

export interface ProjectsService {
  /** The owner's projects (one bot's when `profileId` is given), newest change first. */
  readonly list: (owner: string, profileId?: string) => Promise<ProjectInfo[]>;
  readonly start: (
    owner: string,
    profileId: string,
    input: { title?: string; goal?: string; milestones?: readonly string[] },
  ) => Promise<Outcome>;
  /** Change one project by id; undefined when it is not the owner's. */
  readonly change: (
    owner: string,
    id: string,
    change: ProjectChange,
    by: "bot" | "owner",
  ) => Promise<Outcome | undefined>;
  readonly remove: (owner: string, id: string) => Promise<boolean>;
  readonly onChange: (fn: () => void) => () => void;
}

const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export const projectsService = (converse: ConverseService): ProjectsService => {
  const listeners = new Set<() => void>();
  const read = async (): Promise<ProjectInfo[]> =>
    (await Effect.runPromise(converse.docs.snapshot(ProjectsDoc)))?.projects ?? [];
  /** Run `edit` over a plain copy in one commit; saves what it returns. */
  const commit = async <T>(
    edit: (projects: ProjectInfo[]) => { next?: ProjectInfo[]; value: T },
  ): Promise<T> => {
    const value = await Effect.runPromise(
      converse.docs.commit(async (tx) => {
        const draft = await tx.doc(ProjectsDoc);
        const outcome = edit(plain(draft.projects ?? []));
        if (outcome.next !== undefined) draft.projects = plain(outcome.next);
        return outcome.value;
      }),
    );
    for (const fn of listeners) fn();
    return value;
  };
  return {
    list: async (owner, profileId) =>
      (await read())
        .filter((p) => p.owner === owner && (profileId === undefined || p.profileId === profileId))
        .sort((a, b) => b.updatedAt - a.updatedAt),
    start: (owner, profileId, input) =>
      commit<Outcome>((projects) => {
        const open = projects.filter(
          (p) => p.owner === owner && p.profileId === profileId && isOpen(p),
        );
        const base = { id: randomUUID(), owner, profileId, now: Date.now() };
        const outcome = startProject(input, base, open.length);
        return outcome.ok
          ? { next: [...projects, outcome.project], value: outcome }
          : { value: outcome };
      }),
    change: (owner, id, change, by) =>
      commit<Outcome | undefined>((projects) => {
        const current = projects.find((p) => p.id === id && p.owner === owner);
        if (current === undefined) return { value: undefined };
        const outcome = changeProject(current, change, by, Date.now());
        if (!outcome.ok) return { value: outcome };
        return { next: projects.map((p) => (p.id === id ? outcome.project : p)), value: outcome };
      }),
    remove: (owner, id) =>
      commit<boolean>((projects) => {
        const kept = projects.filter((p) => !(p.id === id && p.owner === owner));
        return kept.length === projects.length ? { value: false } : { next: kept, value: true };
      }),
    onChange: (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  };
};
