/**
 * The evals doc: the saved cases, the last runs, and the conversations that
 * are replays (the guard's durable list, so a replay resumed after a restart
 * still has its tools blocked). Every write is a plain copy: draft values
 * die with the transaction.
 */
import { defineDoc } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import type { External } from "@spriessen/core";
import type { EvalCase, EvalRun } from "@spriessen/contracts";
import type { ConverseService } from "../converse/converse.ts";

/** Runs kept, newest last. */
export const KEPT_RUNS = 20;

type EvalsState = { cases: EvalCase[]; runs: EvalRun[]; replays: string[] };

export const EvalsDoc = defineDoc<EvalsState>({
  kind: "ultiv.evals",
  version: 1,
  scope: "session",
  initial: () => ({ cases: [], runs: [], replays: [] }),
  checkpointWhen: () => true,
});

export const readEvals = (converse: ConverseService): Effect.Effect<EvalsState, External> =>
  Effect.map(converse.docs.snapshot(EvalsDoc), (doc) => ({
    cases: doc?.cases ?? [],
    runs: doc?.runs ?? [],
    replays: doc?.replays ?? [],
  }));

const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Change the doc; `change` gets plain copies and returns the next state's parts. */
export const changeEvals = (
  converse: ConverseService,
  change: (state: EvalsState) => Partial<EvalsState>,
): Effect.Effect<void, External> =>
  converse.docs.commit(async (tx) => {
    const draft = await tx.doc(EvalsDoc);
    // Draft values are proxies: copy through JSON, both ways.
    const current = plain({
      cases: draft.cases ?? [],
      runs: draft.runs ?? [],
      replays: draft.replays ?? [],
    });
    const next = change(current);
    if (next.cases !== undefined) draft.cases = plain(next.cases);
    if (next.runs !== undefined) draft.runs = plain(next.runs.slice(-KEPT_RUNS));
    if (next.replays !== undefined) draft.replays = plain(next.replays);
  });
