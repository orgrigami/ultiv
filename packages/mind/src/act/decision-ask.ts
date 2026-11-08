/**
 * The multi-question Jev tool (`jev`): several typed questions of any
 * primitive in ONE decision call. The batch entry point for related
 * decisions; single-primitive tools live in `decision-tools.ts`.
 */
import { Effect } from "effect";
import { arr, lit, map, num, obj, oneOf, opt, str, union } from "@earendil-works/pi-schema";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { DecideService, JevAnswer, JevQuestionSpec } from "../decide/decide.ts";

const QuestionParams = obj(
  {
    name: str({ description: "Key this answer is reported under." }),
    type: oneOf(["noul", "choice", "score"], {
      description:
        "noul = yes/no probability, choice = pick one of options, score = rubric rating.",
    }),
    instruction: opt(str({ description: "What to decide for this question." })),
    options: opt(arr(str(), { minItems: 2, description: "choice only: the allowed answers." })),
    rubric: opt(
      arr(str(), {
        minItems: 2,
        description: "score only: ordered level descriptions, index = score.",
      }),
    ),
  },
  { open: true },
);

const AskParams = obj(
  {
    state: str({ description: "The subject all questions judge." }),
    questions: arr(QuestionParams, {
      minItems: 1,
      maxItems: 8,
      description: "One entry per decision; noul/score need an instruction, choice needs options.",
    }),
  },
  { open: true },
);

const AskOutput = obj(
  {
    answers: arr(
      union([
        obj(
          {
            name: str(),
            type: lit("noul"),
            probability: num(),
          },
          { open: true },
        ),
        obj(
          {
            name: str(),
            type: lit("choice"),
            choice: str(),
            confidence: num(),
          },
          { open: true },
        ),
        obj(
          {
            name: str(),
            type: lit("score"),
            score: num(),
            confidence: num(),
            probabilities: map(num()),
          },
          { open: true },
        ),
      ]),
    ),
  },
  { open: true },
);

type RawQuestion = {
  name: string;
  type: string;
  instruction?: string;
  options?: readonly string[];
  rubric?: readonly string[];
};

/** Build validated specs from the flat tool args; throws a model-readable error when malformed. */
export function specsOf(questions: readonly RawQuestion[]): JevQuestionSpec[] {
  return questions.map((question) => {
    if (question.type === "noul") {
      if (question.instruction === undefined) {
        throw new Error(`${question.name}: noul needs an instruction (phrased as yes/no).`);
      }
      return { name: question.name, type: "noul", instructions: question.instruction };
    }
    if (question.type === "choice") {
      if (question.instruction === undefined || question.options === undefined) {
        throw new Error(`${question.name}: choice needs an instruction and options.`);
      }
      return {
        name: question.name,
        type: "choice",
        instructions: question.instruction,
        options: question.options,
      };
    }
    if (question.rubric === undefined) {
      throw new Error(`${question.name}: score needs a rubric (at least two levels).`);
    }
    return {
      name: question.name,
      type: "score",
      instructions: question.instruction ?? null,
      rubric: question.rubric,
    };
  });
}

function lineOf(answer: JevAnswer): string {
  if (answer.type === "noul") return `${answer.name}: ${answer.probability}`;
  if (answer.type === "choice") return `${answer.name}: ${answer.choice}`;
  return `${answer.name}: ${answer.score} (confidence ${answer.confidence})`;
}

/** Ask several typed questions (any primitive except box) to Jev in ONE call. */
export function askTool(decide: DecideService): ToolRegistration<typeof AskParams> {
  return {
    name: "jev",
    description:
      "Your typed decision faculty (Jev), several questions in one call. Each question is a noul (yes/no probability), choice (pick one of options), or score (rubric rating). Batch related decisions here instead of many single calls.",
    parameters: AskParams,
    structuredOutputSchema: AskOutput,
    execute: async (args) => {
      const specs = specsOf(args.questions);
      const answers = await Effect.runPromise(decide.ask(args.state, specs));
      return {
        output: [{ type: "text", text: answers.map(lineOf).join("\n") }],
        structuredOutput: { answers },
      };
    },
  };
}
