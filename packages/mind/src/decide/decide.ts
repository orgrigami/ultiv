/**
 * The Decide faculty: typed decisions through Jev, independent of any
 * conversation. Jev is not only a tool of the agent loop — this faculty is
 * the entity's second voice, callable with zero chat infrastructure. The
 * same faculty also appears as native agent tools (see `act/decision-tools`).
 */
import {
  choice,
  noul,
  score,
  TypeSafeClient,
  type ChoiceResponse,
  type EntryType,
  type NoulResponse,
  type Question,
  type Questions,
  type ScoreResponse,
  type SystemOneResult,
} from "@typesafe-ai/sdk";
import { Context, Effect, Layer, Option } from "effect";
import { ConfigError } from "effect/Config";
import { External, Unavailable } from "@spreissen/core";
import {
  TYPESAFE_DEFAULT_BASE_URL,
  typesafeApiKey,
  typesafeBaseUrl,
  typesafeModel,
} from "../config.ts";
import { typesafeGateway, type JevGateway } from "./gateway.ts";

/** Jev's rubric rating: expected score, confidence, and per-level probabilities. */
export type JevRating = {
  readonly score: number;
  readonly confidence: number;
  readonly probabilities: Readonly<Record<string, number>>;
};

/** One dynamic Jev question: a named noul, choice, or score. */
export type JevQuestionSpec =
  | { readonly name: string; readonly type: "noul"; readonly instructions: string }
  | {
      readonly name: string;
      readonly type: "choice";
      readonly instructions: string;
      readonly options: readonly string[];
    }
  | {
      readonly name: string;
      readonly type: "score";
      readonly instructions: string | null;
      readonly rubric: readonly string[];
    };

/** Jev's answer to one dynamic question, tagged with its primitive and the asked name. */
export type JevAnswer =
  | { readonly name: string; readonly type: "noul"; readonly probability: number }
  | {
      readonly name: string;
      readonly type: "choice";
      readonly choice: string;
      readonly confidence: number;
    }
  | ({ readonly name: string; readonly type: "score" } & JevRating);

export type DecideError = Unavailable | External;

export interface DecideService {
  /** False when TYPESAFE_API_KEY is not configured; calls then fail with `Unavailable`. */
  readonly available: boolean;
  /** Typed yes/no: Jev's probability (0..1) that the statement holds. */
  readonly yesNo: (
    state: NonNullable<EntryType>,
    instructions: string,
  ) => Effect.Effect<number, DecideError>;
  /** Typed pick: Jev chooses exactly one of the options. */
  readonly pick: (
    question: string,
    options: readonly string[],
  ) => Effect.Effect<string, DecideError>;
  /** Rubric rating of a state against ordered levels (index = score). */
  readonly rate: (
    state: NonNullable<EntryType>,
    instructions: string,
    rubric: readonly string[],
  ) => Effect.Effect<JevRating, DecideError>;
  /** Several questions of any primitive in ONE Jev call; answers in spec order. */
  readonly ask: (
    state: NonNullable<EntryType>,
    specs: readonly JevQuestionSpec[],
  ) => Effect.Effect<JevAnswer[], DecideError>;
}

export class Decide extends Context.Service<Decide, DecideService>()("spreissen/mind/Decide") {}

type Answers = Record<string, NoulResponse | ChoiceResponse | ScoreResponse | undefined>;

const systemOne = <const Q extends Questions>(
  gateway: JevGateway | undefined,
  request: { readonly state: NonNullable<EntryType>; readonly questions: Q },
): Effect.Effect<SystemOneResult<Q>, DecideError> =>
  gateway === undefined
    ? Effect.fail(new Unavailable({ faculty: "decide", why: "TYPESAFE_API_KEY is not set" }))
    : Effect.tryPromise({
        try: () => gateway.systemOne(request),
        catch: (cause) => new External({ op: "jev systemOne", cause }),
      });

const questionOf = (spec: JevQuestionSpec): Question => {
  if (spec.type === "noul") return noul(spec.instructions);
  if (spec.type === "choice") {
    return choice(
      spec.instructions,
      Object.fromEntries(spec.options.map((option) => [option, option])),
    );
  }
  return score(spec.instructions ?? null, spec.rubric);
};

const answerOf = (
  spec: JevQuestionSpec,
  answers: Answers,
): Effect.Effect<JevAnswer, DecideError> => {
  const answer = answers[spec.name];
  const mismatch = (detail: unknown) =>
    new External({ op: `jev ${spec.type} answer for ${spec.name}`, cause: detail });
  if (spec.type === "noul") {
    if (answer?.type !== "noul") return Effect.fail(mismatch(answer));
    return Effect.succeed({ name: spec.name, type: "noul", probability: answer.noul });
  }
  if (spec.type === "choice") {
    if (answer?.type !== "choice") return Effect.fail(mismatch(answer));
    return Effect.succeed({
      name: spec.name,
      type: "choice",
      choice: answer.choice,
      confidence: answer.confidence,
    });
  }
  if (answer?.type !== "score") return Effect.fail(mismatch(answer));
  return Effect.succeed({
    name: spec.name,
    type: "score",
    score: answer.score,
    confidence: answer.confidence,
    probabilities: { ...answer.probabilities },
  });
};

export const decideService = (gateway: JevGateway | undefined): DecideService => ({
  available: gateway !== undefined,
  yesNo: (state, instructions) =>
    Effect.flatMap(
      systemOne(gateway, { state, questions: { answer: noul(instructions) } }),
      (result) => {
        const answer = result.answers.answer;
        if (answer?.type !== "noul")
          return Effect.fail(new External({ op: "jev yesNo", cause: answer }));
        return Effect.succeed(answer.noul);
      },
    ),
  pick: (question, options) =>
    Effect.flatMap(
      systemOne(gateway, {
        state: question,
        questions: {
          answer: choice(question, Object.fromEntries(options.map((option) => [option, option]))),
        },
      }),
      (result) => {
        const answer = result.answers.answer;
        if (answer?.type !== "choice")
          return Effect.fail(new External({ op: "jev pick", cause: answer }));
        return Effect.succeed(answer.choice);
      },
    ),
  rate: (state, instructions, rubric) =>
    Effect.flatMap(
      systemOne(gateway, { state, questions: { answer: score(instructions, rubric) } }),
      (result) => {
        const answer = result.answers.answer;
        if (answer?.type !== "score")
          return Effect.fail(new External({ op: "jev rate", cause: answer }));
        return Effect.succeed<JevRating>({
          score: answer.score,
          confidence: answer.confidence,
          probabilities: { ...answer.probabilities },
        });
      },
    ),
  ask: (state, specs) =>
    Effect.flatMap(
      systemOne(gateway, {
        state,
        questions: Object.fromEntries(specs.map((spec) => [spec.name, questionOf(spec)])),
      }),
      (result) => Effect.all(specs.map((spec) => answerOf(spec, result.answers as Answers))),
    ),
});

/** The Decide faculty from the environment; unavailable (loudly) without a key. */
export const decideLayer: Layer.Layer<Decide, ConfigError | Unavailable> = Layer.effect(
  Decide,
  Effect.gen(function* () {
    const key = yield* typesafeApiKey;
    // A blank line in .env is "not set", for the key and the endpoint alike.
    if (Option.isNone(key) || key.value.trim() === "") return decideService(undefined);
    const model = yield* typesafeModel;
    const configuredBase = yield* typesafeBaseUrl;
    const baseURL =
      Option.isSome(configuredBase) && configuredBase.value.trim() !== ""
        ? configuredBase.value.trim()
        : TYPESAFE_DEFAULT_BASE_URL;
    const gateway = yield* Effect.try({
      try: () =>
        typesafeGateway(new TypeSafeClient({ apiKey: key.value, defaultModel: model, baseURL })),
      catch: (cause) => new Unavailable({ faculty: "decide", why: String(cause) }),
    });
    return decideService(gateway);
  }),
);
