/**
 * The owner's lens on the `project` tool: what the bot did with a project
 * (started, updated, listed, looked at), the project's name beside it, and
 * the bot's own words (the project as it now reads) as the body.
 */
import { PROJECT_TOOL, type ToolStep } from "@spriessen/contracts";
import type { ToolView } from "./tool-text.ts";
import { clip, flatOf, rawOf, recordOf } from "./tool-values.ts";

const WORDS: Record<string, readonly [string, string]> = {
  start: ["Started a project", "Starting a project…"],
  update: ["Updated a project", "Updating a project…"],
  list: ["Looked at its projects", "Looking at its projects…"],
  show: ["Read a project", "Reading a project…"],
};

/** The project's title from the result details, else the call's own title. */
const titleOf = (step: ToolStep, input: Record<string, unknown>): string | undefined =>
  flatOf(recordOf(step.details)["title"]) ?? flatOf(input["title"]);

export function projectView(step: ToolStep): ToolView | null {
  if (step.name !== PROJECT_TOOL) return null;
  const input = recordOf(step.input);
  const action = typeof input["action"] === "string" ? input["action"] : "update";
  const [done, live] = WORDS[action] ?? (WORDS.update as readonly [string, string]);
  const title = titleOf(step, input);
  const output = rawOf(step.output);
  return {
    family: "task",
    done,
    live,
    ...(title !== undefined ? { detail: clip(title, 36) } : {}),
    ...(output !== undefined
      ? { structured: { t: "output", text: clip(output, 8000) ?? output } }
      : {}),
  };
}
