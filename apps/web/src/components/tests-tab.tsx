/**
 * A bot's Tests tab (Crew › Tests): messages saved from its chats ("Save as
 * test" on your message) replay on its current setup, or a model you pick,
 * with every tool blocked, and each reply is graded against what you expect
 * and against what it said the first time. Refreshes on the `evals` live
 * signal; the newest run that covered this bot's tests shows its results.
 */
import { useMemo, useState } from "react";
import type { EvalCase, EvalRun, ProfileInfo } from "@spriessen/contracts";
import { plural } from "@spriessen/present/plural";
import { CharacterEmpty } from "@/components/character-empty";
import { Mark } from "@/components/state-mark";
import { ModelOptions } from "@/components/model-options";
import { TestCaseRow } from "@/components/test-case-row";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/empty-state";
import { Select } from "@/components/ui/select";
import { SkeletonRows } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { useApp } from "@/lib/app-state";
import { formatWhen } from "@/lib/format";
import { notifyError } from "@/lib/notify";
import { useLiveLoad } from "@/lib/use-live-load";

type TestsState = { cases: EvalCase[]; runs: EvalRun[] };

function RunResults({ run, cases }: { run: EvalRun; cases: readonly EvalCase[] }) {
  const passed = run.results.filter((result) => result.ok).length;
  const titleOf = (id: string) => cases.find((item) => item.id === id)?.title ?? "A removed test";
  return (
    <section aria-label="Latest run" className="flex flex-col gap-2">
      <p className="text-sm">
        {run.status === "running"
          ? `Running… ${run.results.length} of ${run.caseIds.length} done`
          : `${passed} of ${run.caseIds.length} passed`}
        <span className="text-muted-foreground">
          {" "}
          · {run.model ?? "its own model"} · {formatWhen(run.startedAt)}
        </span>
      </p>
      {run.error !== null && <p className="text-signal text-xs">{run.error}</p>}
      <ul className="bg-card divide-border divide-y rounded-xl border">
        {run.results.map((result) => (
          <li key={result.caseId} className="flex items-start gap-2.5 px-3 py-2.5">
            <Mark
              kind={result.ok ? "done" : "error"}
              tone={result.ok ? "ok" : "signal"}
              label={result.ok ? "Passed" : "Failed"}
              className="mt-0.5 size-3.5 shrink-0"
            />
            <details className="min-w-0 flex-1">
              <summary className="cursor-pointer text-sm break-words">
                {titleOf(result.caseId)}
                {result.score !== null && (
                  <span className="text-muted-foreground tnum">
                    {" "}
                    · Jev{" "}
                    {new Intl.NumberFormat("en", { maximumFractionDigits: 2 }).format(result.score)}
                  </span>
                )}
              </summary>
              {result.error !== null && <p className="text-signal text-xs">{result.error}</p>}
              {result.checks.map((check) => (
                <p key={check.name} className="text-muted-foreground text-xs break-words">
                  {check.ok ? "✓" : "✗"} {check.name}: {check.detail}
                </p>
              ))}
              <p className="text-muted-foreground mt-1 text-xs">
                Tools it tried: {result.tools.length === 0 ? "none" : result.tools.join(", ")}
              </p>
              <p className="mt-1 text-sm whitespace-pre-wrap break-words">
                {result.reply === "" ? "(no reply)" : result.reply}
              </p>
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function TestsTab({ bot }: { bot: ProfileInfo }) {
  const { sessions } = useApp();
  const [model, setModel] = useState("");
  const [starting, setStarting] = useState(false);
  const state = useLiveLoad<TestsState>(
    `tests:${bot.id}`,
    async () => {
      const [cases, runs] = await Promise.all([api.evals(bot.id), api.evalRuns()]);
      return { cases, runs };
    },
    ["evals"],
    "Tests may be out of date",
  );
  const latest = useMemo(() => {
    const ids = new Set(state.value?.cases.map((item) => item.id) ?? []);
    return state.value?.runs.find((run) => run.caseIds.some((id) => ids.has(id)));
  }, [state.value]);
  if (state.failed) return <ErrorState message="Couldn't load the tests." onRetry={state.retry} />;
  if (state.value === null) return <SkeletonRows label="Loading tests" />;
  const { cases } = state.value;
  if (cases.length === 0)
    return (
      <CharacterEmpty bot={bot} title="No tests yet">
        In a chat with {bot.name}, tap the flask under one of your messages (or type /test after it
        in the terminal app). A run replays it on {bot.name}'s current setup, with tools blocked,
        and grades the reply.
      </CharacterEmpty>
    );
  const start = async (): Promise<void> => {
    setStarting(true);
    try {
      await api.evalStart({ botId: bot.id, ...(model !== "" ? { model } : {}) });
    } catch (cause) {
      notifyError("Couldn't start the run", cause);
    } finally {
      setStarting(false);
    }
  };
  const running = latest?.status === "running";
  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground text-xs">
        Each test replays one of your messages in a copy of its chat, on {bot.name}'s current setup.
        Tools don't run. A test passes when its expectations hold and Jev rates the reply at least
        as good as the first one.
      </p>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <label className="flex flex-1 flex-col gap-1 text-sm">
          Replay on
          <Select value={model} onChange={(event) => setModel(event.target.value)}>
            <option value="">Its own model</option>
            <ModelOptions models={sessions.models} />
          </Select>
        </label>
        <Button type="button" onClick={() => void start()} disabled={starting || running}>
          {running ? "Running…" : `Run ${cases.length} ${plural(cases.length, "test", "tests")}`}
        </Button>
      </div>
      {latest !== undefined && <RunResults run={latest} cases={cases} />}
      <ul aria-label="Saved tests" className="bg-card divide-border divide-y rounded-xl border">
        {cases.map((item) => (
          <TestCaseRow key={item.id} item={item} />
        ))}
      </ul>
    </div>
  );
}
