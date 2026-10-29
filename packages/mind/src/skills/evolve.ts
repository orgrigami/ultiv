/**
 * skill_evolve: self-improvement of a skill as a background task, the loop
 * self-evolution runs without any training: reread the skill, mine the bot's
 * own transcripts for how its past runs actually went, draft candidate
 * revisions, judge them (Jev when configured), and land the survivor as a
 * proposal for the owner, or as a direct write when the owner asked for the
 * improvement. The task runs as the bot, so the loop uses the same tools the
 * bot has, and the parent is woken with the result instead of polling.
 */
import { Type } from "typebox";
import { Effect } from "effect";
import { defineTool, type Tool } from "@ultiv/ext";
import type { ProfilesService } from "../profiles/profiles.ts";
import type { TasksService } from "../tasks/tasks.ts";
import { AGENT_OWNER } from "../act/task-tools.ts";
import { MAX_SKILL_CHARS } from "./guard.ts";
import type { SkillsService } from "./service.ts";
import { skillsScope } from "./tools.ts";

export type EvolveMode = "propose" | "apply";

/** The procedure the evolution task follows, above its specific skill. */
export const evolveBrief = (input: {
  readonly skill: string;
  readonly version: number;
  readonly mode: EvolveMode;
  readonly focus: string;
}): string =>
  [
    `Evolve the skill "${input.skill}" (now at v${input.version}). Work the loop:`,
    "",
    "1. skill_load to reread its full text and description.",
    `2. Gather evidence: history_search for "${input.skill}" and the phrases of the work it`,
    "   covers. Find up to 3 past runs where this skill (or the procedure it distills) was",
    "   used. Note what worked, what failed, and why it failed.",
    "3. Write 3 to 6 eval cases: a situation plus what a good execution does. Draw them from",
    "   the evidence; when history is thin, say so and use realistic ones.",
    "4. Draft 3 candidate revisions of the body. Each must keep the skill's purpose (semantic",
    `   preservation), stay under ${MAX_SKILL_CHARS} chars, and change only what the evidence supports.`,
    input.focus !== "" ? `   This run's focus: ${input.focus}` : "",
    "5. Judge every candidate against the eval cases. Prefer jev_rate with a rubric like:",
    "   broken / worse than current / about equal / clearly better. Without jev tools, score",
    "   them yourself, in writing, honestly.",
    "6. Pick the winner. If none clearly beats the current body, change nothing and report",
    "   that; churn is not improvement.",
    input.mode === "apply"
      ? `7. Apply: skill_write "${input.skill}" with the winner's full SKILL.md text.`
      : `7. Park it: skill_propose "${input.skill}" with the winner's full SKILL.md text and a one-line note. Never overwrite the skill directly.`,
    "8. Final reply, at most 4 lines: the failure themes you found; what changed (or `nothing survived judgment`); where it landed (new version or proposal id); and one line for the owner on what to expect next time.",
    "",
    "Constraints: at most ~15 tool calls total; never put secrets in skill text; never spawn sub-tasks.",
  ].join("\n");

/** skill_evolve: one skill's improvement loop, as a task. */
export const evolveTool = (
  skills: SkillsService,
  profiles: ProfilesService,
  tasks: TasksService,
): Tool =>
  defineTool({
    name: "skill_evolve",
    description:
      'Start a background task that improves one of your skills from evidence: it mines your past runs, drafts candidate revisions, judges them (Jev when available) and lands the best one. mode "propose" (default) parks the result for your owner; "apply" is only for when your owner explicitly asked for this improvement. End your turn after starting; you are woken with the result.',
    parameters: Type.Object({
      skill: Type.String({ description: "The skill's name." }),
      focus: Type.Optional(
        Type.String({ description: "One line narrowing this run: what to improve or watch for." }),
      ),
      mode: Type.Optional(
        Type.Union([Type.Literal("propose"), Type.Literal("apply")], {
          description: '"propose" (default) or "apply" (owner asked directly).',
        }),
      ),
    }),
    structuredOutputSchema: Type.Object({ id: Type.String(), status: Type.String() }),
    execute: async (args, api) => {
      const spawning = String(api.conversationId);
      if (await tasks.isTaskConversation(spawning)) {
        return {
          output: [
            {
              type: "text" as const,
              text: "refused: you are already running AS a background task; do the evolution inline or let the parent decide",
            },
          ],
          isError: true as const,
        };
      }
      const resolved = skillsScope(profiles, spawning);
      if ("refused" in resolved) {
        return {
          output: [{ type: "text" as const, text: resolved.refused }],
          isError: true as const,
        };
      }
      const { owner, profileId } = resolved.scope;
      const current = await skills.read(owner, profileId, args.skill);
      if (current === undefined) {
        return {
          output: [{ type: "text" as const, text: `no skill named "${args.skill}"` }],
          isError: true as const,
        };
      }
      if (current.meta.origin === "builtin") {
        return {
          output: [
            {
              type: "text" as const,
              text: `"${args.skill}" is a built-in skill: it updates with the app. Copy it with skill_write first if you want your own variant.`,
            },
          ],
          isError: true as const,
        };
      }
      const task = await Effect.runPromise(
        tasks.spawn({
          sessionId: "",
          owner: AGENT_OWNER,
          conversationId: spawning,
          title: `Evolve: ${args.skill}`.slice(0, 40),
          prompt: evolveBrief({
            skill: args.skill,
            version: current.meta.version,
            mode: args.mode ?? "propose",
            focus: args.focus ?? "",
          }),
        }),
      );
      return {
        ...textReply(
          `evolution task ${task.id} running for "${args.skill}". End your turn; you will be woken with its result.`,
        ),
        structuredOutput: { id: task.id, status: task.status },
      };
    },
  });

const textReply = (value: string, isError = false) =>
  isError
    ? { output: [{ type: "text" as const, text: value }], isError: true as const }
    : { output: [{ type: "text" as const, text: value }] };
