/**
 * Projects: a goal a bot works toward over days. One record per project,
 * per bot: the goal, milestones it ticks off, a short progress log, and a
 * status. The `project` tool writes them; a compact "active projects" prompt
 * section keeps them in view on every turn; the owner reads and steers them
 * on Crew › bot › Projects. Plain REST payloads, never a chord object.
 */
import {
  arr,
  bool,
  nul,
  num,
  obj,
  oneOf,
  opt,
  str,
  union,
  type Static,
} from "@earendil-works/pi-schema";

export const PROJECT_TOOL = "project";

export const PROJECT_LIMITS = {
  title: 80,
  goal: 600,
  milestones: 20,
  milestone: 160,
  note: 400,
  /** Log lines kept per project, newest last. */
  log: 50,
  /** Active (or paused) projects one bot may hold. */
  open: 10,
} as const;

export const ProjectStatusSchema = oneOf(["active", "paused", "done", "dropped"]);
export type ProjectStatus = Static<typeof ProjectStatusSchema>;

export const ProjectMilestoneSchema = obj(
  {
    text: str(),
    done: bool(),
    doneAt: union([num(), nul()]),
  },
  { open: true },
);
export type ProjectMilestone = Static<typeof ProjectMilestoneSchema>;

export const ProjectLogLineSchema = obj(
  {
    at: num(),
    text: str(),
    by: oneOf(["bot", "owner"]),
  },
  { open: true },
);
export type ProjectLogLine = Static<typeof ProjectLogLineSchema>;

export const ProjectInfoSchema = obj(
  {
    id: str(),
    owner: str(),
    profileId: str(),
    title: str(),
    goal: str(),
    status: ProjectStatusSchema,
    milestones: arr(ProjectMilestoneSchema),
    log: arr(ProjectLogLineSchema),
    createdAt: num(),
    updatedAt: num(),
  },
  { open: true },
);
export type ProjectInfo = Static<typeof ProjectInfoSchema>;

/**
 * The work linked to a project: tasks spawned for it and routines set for
 * it (both carry `projectId`). A projection on GET /api/projects rows and in
 * the `project` tool's `show`; never stored on the project itself.
 */
export const ProjectWorkSchema = obj(
  {
    tasks: arr(
      obj(
        {
          id: str(),
          title: str(),
          status: str(),
          createdAt: num(),
          finishedAt: union([num(), nul()]),
        },
        { open: true },
      ),
    ),
    routines: arr(
      obj(
        {
          id: str(),
          schedule: str(),
          once: union([num(), nul()]),
          prompt: str(),
          enabled: bool(),
          trial: bool(),
        },
        { open: true },
      ),
    ),
  },
  { open: true },
);
export type ProjectWork = Static<typeof ProjectWorkSchema>;

/** Linked tasks shown per project (newest first). */
export const PROJECT_WORK_TASKS = 10;

/** The `project` tool's parameters: one action per call. */
export const ProjectParamsSchema = obj(
  {
    action: oneOf(["start", "update", "list", "show"], {
      description: "start a project, update one, list yours, or show one in full.",
    }),
    id: opt(str({ description: "update / show: the project's #handle (its first characters)." })),
    title: opt(str({ description: "start: a short name." })),
    goal: opt(str({ description: "start: what done looks like, in a sentence or two." })),
    milestones: opt(arr(str(), { description: "start: the steps toward the goal, in order." })),
    done: opt(arr(num(), { description: "update: milestone numbers now done (1 = first)." })),
    add: opt(arr(str(), { description: "update: milestones to add." })),
    note: opt(
      str({ description: "update: one line of progress for the log (what changed, why)." }),
    ),
    status: opt(ProjectStatusSchema),
  },
  { open: true },
);
export type ProjectParams = Static<typeof ProjectParamsSchema>;

/** What the owner may change from the app (PATCH /api/projects/:id). */
export type ProjectOwnerPatch = {
  status?: ProjectStatus;
  /** Milestone numbers (1-based) to mark done or not done. */
  done?: number[];
  undone?: number[];
  note?: string;
};
