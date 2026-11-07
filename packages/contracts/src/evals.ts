/**
 * Behaviour tests (evals): a case is one real owner message from a bot's
 * chat, with what the bot did then (the reference) and optional
 * expectations. A run replays each case in a fork of its chat taken just
 * before that message, on the bot's current setup (or a model you pick),
 * with every tool call blocked, and grades the new reply: the expectations
 * first, then Jev comparing it with the reference. Plain REST, never a
 * chord object.
 */
import { Type, type Static } from "typebox";

/** Cases one run replays at most (each is a real model turn). */
export const EVAL_RUN_MAX_CASES = 25;

export const EvalExpectSchema = Type.Object({
  /** Tools the reply must call. */
  tools: Type.Optional(Type.Array(Type.String())),
  /** Tools the reply must not call. */
  notTools: Type.Optional(Type.Array(Type.String())),
  /** Phrases the reply must contain (case-insensitive). */
  contains: Type.Optional(Type.Array(Type.String())),
  /** A plain-language rule Jev checks the reply against. */
  rubric: Type.Optional(Type.String()),
});
export type EvalExpect = Static<typeof EvalExpectSchema>;

export const EvalCaseSchema = Type.Object({
  id: Type.String(),
  owner: Type.String(),
  profileId: Type.String(),
  title: Type.String(),
  /** The chat the message came from, and its transcript id there. */
  sessionId: Type.String(),
  at: Type.Number(),
  /** The durable conversation and the entry the replay forks after (null: from scratch). */
  conversationId: Type.String(),
  forkAt: Type.Union([Type.Number(), Type.Null()]),
  /** The owner's message, replayed as is. */
  input: Type.String(),
  /** What the bot did when the message was real. */
  reference: Type.Object({ reply: Type.String(), tools: Type.Array(Type.String()) }),
  expect: EvalExpectSchema,
  createdAt: Type.Number(),
});
export type EvalCase = Static<typeof EvalCaseSchema>;

export const EvalCheckSchema = Type.Object({
  name: Type.String(),
  ok: Type.Boolean(),
  detail: Type.String(),
});
export type EvalCheck = Static<typeof EvalCheckSchema>;

export const EvalResultSchema = Type.Object({
  caseId: Type.String(),
  ok: Type.Boolean(),
  reply: Type.String(),
  /** Tools the replay tried to call (blocked, never run). */
  tools: Type.Array(Type.String()),
  checks: Type.Array(EvalCheckSchema),
  /** Jev's probability that the reply is at least as good as the reference; null without Jev. */
  score: Type.Union([Type.Number(), Type.Null()]),
  error: Type.Union([Type.String(), Type.Null()]),
});
export type EvalResult = Static<typeof EvalResultSchema>;

export const EvalRunSchema = Type.Object({
  id: Type.String(),
  owner: Type.String(),
  /** The model replayed on; null = each bot's own chat model. */
  model: Type.Union([Type.String(), Type.Null()]),
  status: Type.Union([Type.Literal("running"), Type.Literal("done"), Type.Literal("failed")]),
  caseIds: Type.Array(Type.String()),
  results: Type.Array(EvalResultSchema),
  startedAt: Type.Number(),
  finishedAt: Type.Union([Type.Number(), Type.Null()]),
  error: Type.Union([Type.String(), Type.Null()]),
});
export type EvalRun = Static<typeof EvalRunSchema>;

/** POST /api/evals: save a message of a chat as a case. */
export type EvalCaseCreate = {
  sessionId: string;
  at: number;
  title?: string;
  expect?: EvalExpect;
};

/** POST /api/evals/run: replay some cases (default: all of a bot's, or all). */
export type EvalRunRequest = {
  botId?: string;
  caseIds?: string[];
  model?: string;
};
