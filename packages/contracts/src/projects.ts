/**
 * Projects: a goal a bot works toward over days. One record per project,
 * per bot: the goal, milestones it ticks off, a short progress log, and a
 * status. The `project` tool writes them; a compact "active projects" prompt
 * section keeps them in view on every turn; the owner reads and steers them
 * on Crew › bot › Projects. Plain REST payloads, never a chord object.
 */
import { Type, type Static } from "typebox";

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

export const ProjectStatusSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("paused"),
  Type.Literal("done"),
  Type.Literal("dropped"),
]);
export type ProjectStatus = Static<typeof ProjectStatusSchema>;

export const ProjectMilestoneSchema = Type.Object({
  text: Type.String(),
  done: Type.Boolean(),
  doneAt: Type.Union([Type.Number(), Type.Null()]),
});
export type ProjectMilestone = Static<typeof ProjectMilestoneSchema>;

export const ProjectLogLineSchema = Type.Object({
  at: Type.Number(),
  text: Type.String(),
  by: Type.Union([Type.Literal("bot"), Type.Literal("owner")]),
});
export type ProjectLogLine = Static<typeof ProjectLogLineSchema>;

export const ProjectInfoSchema = Type.Object({
  id: Type.String(),
  owner: Type.String(),
  profileId: Type.String(),
  title: Type.String(),
  goal: Type.String(),
  status: ProjectStatusSchema,
  milestones: Type.Array(ProjectMilestoneSchema),
  log: Type.Array(ProjectLogLineSchema),
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
});
export type ProjectInfo = Static<typeof ProjectInfoSchema>;

/** The `project` tool's parameters: one action per call. */
export const ProjectParamsSchema = Type.Object({
  action: Type.Union(
    [Type.Literal("start"), Type.Literal("update"), Type.Literal("list"), Type.Literal("show")],
    { description: "start a project, update one, list yours, or show one in full." },
  ),
  id: Type.Optional(
    Type.String({ description: "update / show: the project's #handle (its first characters)." }),
  ),
  title: Type.Optional(Type.String({ description: "start: a short name." })),
  goal: Type.Optional(
    Type.String({ description: "start: what done looks like, in a sentence or two." }),
  ),
  milestones: Type.Optional(
    Type.Array(Type.String(), { description: "start: the steps toward the goal, in order." }),
  ),
  done: Type.Optional(
    Type.Array(Type.Number(), { description: "update: milestone numbers now done (1 = first)." }),
  ),
  add: Type.Optional(Type.Array(Type.String(), { description: "update: milestones to add." })),
  note: Type.Optional(
    Type.String({ description: "update: one line of progress for the log (what changed, why)." }),
  ),
  status: Type.Optional(ProjectStatusSchema),
});
export type ProjectParams = Static<typeof ProjectParamsSchema>;

/** What the owner may change from the app (PATCH /api/projects/:id). */
export type ProjectOwnerPatch = {
  status?: ProjectStatus;
  /** Milestone numbers (1-based) to mark done or not done. */
  done?: number[];
  undone?: number[];
  note?: string;
};
