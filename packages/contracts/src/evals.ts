/**
 * Behaviour tests (evals): a case is one real owner message from a bot's
 * chat, with what the bot did then (the reference) and optional
 * expectations. A run replays each case in a fork of its chat taken just
 * before that message, on the bot's current setup (or a model you pick),
 * with every tool call blocked, and grades the new reply: the expectations
 * first, then Jev comparing it with the reference. Plain REST, never a
 * chord object.
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

/** Cases one run replays at most (each is a real model turn). */
export const EVAL_RUN_MAX_CASES = 25;

export const EvalExpectSchema = obj(
  {
    /** Tools the reply must call. */
    tools: opt(arr(str())),
    /** Tools the reply must not call. */
    notTools: opt(arr(str())),
    /** Phrases the reply must contain (case-insensitive). */
    contains: opt(arr(str())),
    /** A plain-language rule Jev checks the reply against. */
    rubric: opt(str()),
  },
  { open: true },
);
export type EvalExpect = Static<typeof EvalExpectSchema>;

export const EvalCaseSchema = obj(
  {
    id: str(),
    owner: str(),
    profileId: str(),
    title: str(),
    /** The chat the message came from, and its transcript id there. */
    sessionId: str(),
    at: num(),
    /** The durable conversation and the entry the replay forks after (null: from scratch). */
    conversationId: str(),
    forkAt: union([num(), nul()]),
    /** The owner's message, replayed as is. */
    input: str(),
    /** What the bot did when the message was real. */
    reference: obj({ reply: str(), tools: arr(str()) }, { open: true }),
    expect: EvalExpectSchema,
    createdAt: num(),
  },
  { open: true },
);
export type EvalCase = Static<typeof EvalCaseSchema>;

export const EvalCheckSchema = obj(
  {
    name: str(),
    ok: bool(),
    detail: str(),
  },
  { open: true },
);
export type EvalCheck = Static<typeof EvalCheckSchema>;

export const EvalResultSchema = obj(
  {
    caseId: str(),
    ok: bool(),
    reply: str(),
    /** Tools the replay tried to call (blocked, never run). */
    tools: arr(str()),
    checks: arr(EvalCheckSchema),
    /** Jev's probability that the reply is at least as good as the reference; null without Jev. */
    score: union([num(), nul()]),
    error: union([str(), nul()]),
  },
  { open: true },
);
export type EvalResult = Static<typeof EvalResultSchema>;

export const EvalRunSchema = obj(
  {
    id: str(),
    owner: str(),
    /** The model replayed on; null = each bot's own chat model. */
    model: union([str(), nul()]),
    status: oneOf(["running", "done", "failed"]),
    caseIds: arr(str()),
    results: arr(EvalResultSchema),
    startedAt: num(),
    finishedAt: union([num(), nul()]),
    error: union([str(), nul()]),
  },
  { open: true },
);
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
