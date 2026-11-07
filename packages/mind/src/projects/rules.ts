/**
 * The rules of projects, pure so the tool, the owner's REST and the tests
 * read one table: starting (title, goal, milestones within limits), the
 * changes a bot or the owner makes (tick or untick milestones, add some, a
 * log line, a status), handle resolution, and the words the model reads.
 */
import {
  PROJECT_LIMITS as LIMITS,
  type ProjectInfo,
  type ProjectStatus,
} from "@spriessen/contracts";

export type Outcome = { ok: true; project: ProjectInfo } | { ok: false; error: string };

const clip = (text: string, max: number): string => text.replace(/\s+/g, " ").trim().slice(0, max);

/** The first 8 characters of the id: the handle every line leads with. */
export const handleOf = (project: ProjectInfo): string => `#${project.id.slice(0, 8)}`;

export const isOpen = (project: ProjectInfo): boolean =>
  project.status === "active" || project.status === "paused";

/** A project from a handle or id prefix (≥ 4 characters), or why not. */
export const resolveProject = (
  projects: readonly ProjectInfo[],
  ref: string | undefined,
): ProjectInfo | string => {
  const key = (ref ?? "").replace(/^#/, "").trim();
  if (key.length < 4) return "give the project's #handle (at least 4 characters)";
  const found = projects.filter((project) => project.id.startsWith(key));
  if (found.length === 1 && found[0] !== undefined) return found[0];
  return found.length === 0 ? `no project #${key}` : `#${key} matches several projects`;
};

export const startProject = (
  input: { title?: string; goal?: string; milestones?: readonly string[] },
  base: { id: string; owner: string; profileId: string; now: number },
  openCount: number,
): Outcome => {
  const title = clip(input.title ?? "", LIMITS.title);
  if (title === "") return { ok: false, error: "a project needs a title" };
  if (openCount >= LIMITS.open) {
    return {
      ok: false,
      error: `you already have ${LIMITS.open} open projects: finish or drop one`,
    };
  }
  const steps = (input.milestones ?? [])
    .map((text) => clip(text, LIMITS.milestone))
    .filter(Boolean);
  if (steps.length > LIMITS.milestones) {
    return { ok: false, error: `at most ${LIMITS.milestones} milestones` };
  }
  return {
    ok: true,
    project: {
      id: base.id,
      owner: base.owner,
      profileId: base.profileId,
      title,
      goal: clip(input.goal ?? "", LIMITS.goal),
      status: "active",
      milestones: steps.map((text) => ({ text, done: false, doneAt: null })),
      log: [],
      createdAt: base.now,
      updatedAt: base.now,
    },
  };
};

export type ProjectChange = {
  done?: readonly number[];
  undone?: readonly number[];
  add?: readonly string[];
  note?: string;
  status?: ProjectStatus;
};

export const changeProject = (
  project: ProjectInfo,
  change: ProjectChange,
  by: "bot" | "owner",
  now: number,
): Outcome => {
  const numbers = [...(change.done ?? []), ...(change.undone ?? [])];
  const bad = numbers.find((n) => !Number.isInteger(n) || n < 1 || n > project.milestones.length);
  if (bad !== undefined) return { ok: false, error: `there is no milestone ${bad}` };
  const added = (change.add ?? []).map((text) => clip(text, LIMITS.milestone)).filter(Boolean);
  if (project.milestones.length + added.length > LIMITS.milestones) {
    return { ok: false, error: `at most ${LIMITS.milestones} milestones` };
  }
  const milestones = project.milestones.map((step, index) => {
    if (change.done?.includes(index + 1) === true && !step.done)
      return { ...step, done: true, doneAt: now };
    if (change.undone?.includes(index + 1) === true) return { ...step, done: false, doneAt: null };
    return step;
  });
  const note = clip(change.note ?? "", LIMITS.note);
  const log = note === "" ? project.log : [...project.log, { at: now, text: note, by }];
  return {
    ok: true,
    project: {
      ...project,
      milestones: [...milestones, ...added.map((text) => ({ text, done: false, doneAt: null }))],
      log: log.slice(-LIMITS.log),
      status: change.status ?? project.status,
      updatedAt: now,
    },
  };
};

const progressOf = (project: ProjectInfo): string => {
  const total = project.milestones.length;
  const done = project.milestones.filter((step) => step.done).length;
  return total === 0 ? "no milestones" : `${done}/${total} milestones`;
};

/** One line for the prompt section and lists. */
export const projectLine = (project: ProjectInfo): string => {
  const next = project.milestones.find((step) => !step.done);
  const paused = project.status === "active" ? "" : ` (${project.status})`;
  return `${handleOf(project)} ${project.title}${paused}: ${progressOf(project)}${next !== undefined ? `; next: ${next.text}` : ""}`;
};

/** The whole project, as the model reads it. */
export const projectText = (project: ProjectInfo): string =>
  [
    `${handleOf(project)} ${project.title} [${project.status}]`,
    project.goal === "" ? "Goal: (none written)" : `Goal: ${project.goal}`,
    ...project.milestones.map((step, i) => `${i + 1}. [${step.done ? "x" : " "}] ${step.text}`),
    ...project.log
      .slice(-5)
      .map(
        (line) => `log ${new Date(line.at).toISOString().slice(0, 10)} (${line.by}): ${line.text}`,
      ),
  ].join("\n");
