/**
 * The evals faculty: save chat messages as cases, replay them as a run on
 * the bots' current setup (or a model you pick), and keep the graded
 * results. A run works through its cases one at a time in the background,
 * saving each result as it lands; `onChange` tells surfaces to refresh. A
 * run cut by a restart is marked failed on the next boot (its finished
 * cases stay). Every read and write is per owner.
 */
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { InvalidInput, NotFound } from "@spriessen/core";
import {
  EVAL_RUN_MAX_CASES,
  type EvalCase,
  type EvalCaseCreate,
  type EvalExpect,
  type EvalRun,
  type EvalRunRequest,
} from "@spriessen/contracts";
import type { DecideService } from "../decide/decide.ts";
import { captureCase, type CaptureDeps } from "./capture.ts";
import { gradeCase } from "./grade.ts";
import { replayCase, type ReplayDeps } from "./replay.ts";
import { changeEvals, readEvals } from "./store.ts";

export interface EvalsService {
  readonly list: (owner: string, profileId?: string) => Promise<EvalCase[]>;
  readonly capture: (owner: string, input: EvalCaseCreate) => Promise<EvalCase>;
  readonly update: (
    owner: string,
    id: string,
    patch: { readonly title?: string; readonly expect?: EvalExpect },
  ) => Promise<EvalCase>;
  readonly remove: (owner: string, id: string) => Promise<boolean>;
  /** The owner's runs, newest first. */
  readonly runs: (owner: string) => Promise<EvalRun[]>;
  readonly getRun: (owner: string, id: string) => Promise<EvalRun | undefined>;
  /** Start a run; resolves with it running, the replays continue in the background. */
  readonly start: (owner: string, request: EvalRunRequest) => Promise<EvalRun>;
  /** Hear any case or run change. Returns the unsubscribe. */
  readonly onChange: (fn: () => void) => () => void;
  /** Mark runs a restart cut as failed (boot). */
  readonly recover: () => Promise<void>;
}

export type EvalsDeps = CaptureDeps &
  ReplayDeps & {
    readonly decide?: DecideService | undefined;
    readonly knownModel: (ref: string) => boolean;
  };

const run = <A>(effect: Effect.Effect<A, unknown>): Promise<A> =>
  Effect.runPromise(effect) as Promise<A>;

/** The cases a run request picks, in saved order. */
const pickCases = (cases: readonly EvalCase[], request: EvalRunRequest): EvalCase[] => {
  const wanted = request.caseIds === undefined ? undefined : new Set(request.caseIds);
  const picked = cases.filter(
    (item) =>
      (wanted === undefined || wanted.has(item.id)) &&
      (request.botId === undefined || item.profileId === request.botId),
  );
  if (wanted !== undefined && picked.length !== wanted.size) {
    throw new NotFound({ what: "one of those tests" });
  }
  if (picked.length === 0) throw new InvalidInput({ reason: "no tests to run" });
  if (picked.length > EVAL_RUN_MAX_CASES) {
    throw new InvalidInput({
      reason: `pick at most ${EVAL_RUN_MAX_CASES} tests per run (${picked.length} selected)`,
    });
  }
  return picked;
};

export const evalsService = (deps: EvalsDeps): EvalsService => {
  const listeners = new Set<() => void>();
  const changed = (): void => {
    for (const fn of listeners) fn();
  };
  const ownCases = async (owner: string) =>
    (await run(readEvals(deps.converse))).cases.filter((item) => item.owner === owner);
  const patchRun = async (id: string, change: (row: EvalRun) => EvalRun): Promise<void> => {
    await run(
      changeEvals(deps.converse, (state) => ({
        runs: state.runs.map((row) => (row.id === id ? change(row) : row)),
      })),
    );
    changed();
  };
  const work = async (row: EvalRun, cases: readonly EvalCase[]): Promise<void> => {
    for (const item of cases) {
      const outcome = await replayCase(deps, item, row.id, row.model);
      const result = await gradeCase(deps.decide, item, outcome);
      await patchRun(row.id, (current) => ({ ...current, results: [...current.results, result] }));
    }
    await patchRun(row.id, (current) => ({ ...current, status: "done", finishedAt: Date.now() }));
  };
  return {
    list: async (owner, profileId) =>
      (await ownCases(owner)).filter(
        (item) => profileId === undefined || item.profileId === profileId,
      ),
    capture: async (owner, input) => {
      const item = await captureCase(deps, owner, input);
      await run(changeEvals(deps.converse, (state) => ({ cases: [...state.cases, item] })));
      changed();
      return item;
    },
    update: async (owner, id, patch) => {
      const current = (await ownCases(owner)).find((item) => item.id === id);
      if (current === undefined) throw new NotFound({ what: `test ${id}` });
      const next: EvalCase = {
        ...current,
        ...(patch.title !== undefined && patch.title.trim() !== ""
          ? { title: patch.title.trim().slice(0, 60) }
          : {}),
        ...(patch.expect !== undefined ? { expect: patch.expect } : {}),
      };
      await run(
        changeEvals(deps.converse, (state) => ({
          cases: state.cases.map((item) => (item.id === id ? next : item)),
        })),
      );
      changed();
      return next;
    },
    remove: async (owner, id) => {
      const exists = (await ownCases(owner)).some((item) => item.id === id);
      if (!exists) return false;
      await run(
        changeEvals(deps.converse, (state) => ({
          cases: state.cases.filter((item) => item.id !== id),
        })),
      );
      changed();
      return true;
    },
    runs: async (owner) =>
      (await run(readEvals(deps.converse))).runs.filter((row) => row.owner === owner).reverse(),
    getRun: async (owner, id) =>
      (await run(readEvals(deps.converse))).runs.find(
        (row) => row.id === id && row.owner === owner,
      ),
    start: async (owner, request) => {
      const model = request.model?.trim() || null;
      if (model !== null && !deps.knownModel(model)) {
        throw new InvalidInput({ reason: `unknown model: ${model}` });
      }
      const cases = pickCases(await ownCases(owner), request);
      const row: EvalRun = {
        id: randomUUID(),
        owner,
        model,
        status: "running",
        caseIds: cases.map((item) => item.id),
        results: [],
        startedAt: Date.now(),
        finishedAt: null,
        error: null,
      };
      await run(changeEvals(deps.converse, (state) => ({ runs: [...state.runs, row] })));
      changed();
      void work(row, cases).catch(async (cause: unknown) => {
        console.error(`eval run ${row.id} failed:`, cause);
        await patchRun(row.id, (current) => ({
          ...current,
          status: "failed",
          finishedAt: Date.now(),
          error: "The run stopped before it finished.",
        })).catch(() => undefined);
      });
      return row;
    },
    onChange: (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    recover: async () => {
      await run(
        changeEvals(deps.converse, (state) => ({
          runs: state.runs.map((row) =>
            row.status === "running"
              ? { ...row, status: "failed", finishedAt: Date.now(), error: "Stopped by a restart." }
              : row,
          ),
        })),
      );
    },
  };
};
