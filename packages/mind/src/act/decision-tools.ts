/**
 * The Decide faculty as native tools of the agent loop (`jev_score`,
 * `jev_pick`, `jev_rate`, and the `jev` batch tool): one capability, two
 * faces. Tools exist only when the faculty is configured, so the loop
 * degrades cleanly without a key. All four are READS — never gated.
 */
import { Effect } from "effect";
import { Type } from "typebox";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { definePlugin, toolCapability, type Plugin, type Tool } from "@spreissen/ext";
import type { DecideService } from "../decide/decide.ts";
import { askTool } from "./decision-ask.ts";

const ScoreParams = Type.Object({
  statement: Type.String({ description: "The claim or situation to judge." }),
  instruction: Type.String({
    description: "What to decide about it, phrased as a yes/no question.",
  }),
});

/** Jev probability (0..1) that the statement holds under the instruction. */
export function scoreTool(decide: DecideService): ToolRegistration<typeof ScoreParams> {
  return {
    name: "jev_score",
    description:
      "Your typed judgment: the probability (0..1) that a statement holds — your own decision faculty, Jev. Prefer it over guessing for yes/no judgments.",
    parameters: ScoreParams,
    structuredOutputSchema: Type.Object({ probability: Type.Number() }),
    execute: async (args) => {
      const probability = await Effect.runPromise(decide.yesNo(args.statement, args.instruction));
      return {
        output: [{ type: "text", text: String(probability) }],
        structuredOutput: { probability },
      };
    },
  };
}

const PickParams = Type.Object({
  question: Type.String({ description: "What to decide, phrased as a question." }),
  options: Type.Array(Type.String(), {
    minItems: 2,
    description: "The allowed answers.",
  }),
});

/** Jev picks exactly one of the given options for the question. */
export function pickTool(decide: DecideService): ToolRegistration<typeof PickParams> {
  return {
    name: "jev_pick",
    description:
      "Your typed decision faculty (Jev): pick exactly one of the given options for a question.",
    parameters: PickParams,
    structuredOutputSchema: Type.Object({ choice: Type.String() }),
    execute: async (args) => {
      const picked = await Effect.runPromise(decide.pick(args.question, args.options));
      return {
        output: [{ type: "text", text: picked }],
        structuredOutput: { choice: picked },
      };
    },
  };
}

const RatingOutput = Type.Object({
  score: Type.Number(),
  confidence: Type.Number(),
  probabilities: Type.Record(Type.String(), Type.Number()),
});

const RateParams = Type.Object({
  state: Type.String({ description: "The thing to rate." }),
  rubric: Type.Array(Type.String(), {
    minItems: 2,
    description: "Ordered level descriptions; the index is the score (0 = first level).",
  }),
  instruction: Type.String({ description: "What to rate the state for." }),
});

/** Jev rates the state against an ordered rubric; the expected score may be fractional. */
export function rateTool(decide: DecideService): ToolRegistration<typeof RateParams> {
  return {
    name: "jev_rate",
    description:
      "Your typed judgment (Jev): rate a state against an ordered rubric. Returns the expected score (may fall between levels), with a confidence.",
    parameters: RateParams,
    structuredOutputSchema: RatingOutput,
    execute: async (args) => {
      const rated = await Effect.runPromise(decide.rate(args.state, args.instruction, args.rubric));
      return {
        output: [{ type: "text", text: `${rated.score} (confidence ${rated.confidence})` }],
        structuredOutput: rated,
      };
    },
  };
}

/** The decision tools in registry order; the batch tool rides last. */
export const decisionTools = (decide: DecideService): readonly Tool[] => [
  scoreTool(decide),
  pickTool(decide),
  rateTool(decide),
  askTool(decide),
];

/** The mind's decision faculty as an installable plugin. */
export const decisionPlugin = (decide: DecideService): Plugin =>
  definePlugin({
    id: "ultiv.mind.decisions",
    version: "1.0.0",
    description: "The mind's decision faculty (Jev) as native tools of the agent loop.",
    capabilities: decisionTools(decide).map(toolCapability),
  });
