/**
 * Trial runs on a schedule row: "Try now" runs the routine once with every
 * action held back, "Go live" lets a trial routine act, Pause/Resume stop
 * and start its fires. The latest trial reads as what the routine WOULD have
 * done: each call it tried, in the same owner words the chat uses, and what
 * it would have said.
 */
import { useState } from "react";
import { isNothingToReport, type CronJobInfo, type RoutineTrial } from "@spriessen/contracts";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { formatWhen } from "@/lib/format";
import { notifyError } from "@/lib/notify";
import { presentationOf } from "@/lib/tool-text";

/** One tried call in owner words ("Sent an email · team"), or null when it is inner monologue. */
export function trialActionText(action: RoutineTrial["actions"][number], index: number) {
  const presented = presentationOf({
    callId: String(index),
    name: action.name,
    status: "done",
    input: action.input,
    output: null,
    durationMs: null,
  });
  if (presented.kind === "hidden") return null;
  const { done, detail } = presented.view;
  return detail !== undefined && detail !== "" ? `${done} · ${detail}` : done;
}

/** What the latest trial would have done. */
export function TrialResult({ trial }: { trial: RoutineTrial }) {
  const actions = trial.actions
    .map((action, index) => trialActionText(action, index))
    .filter((line): line is string => line !== null);
  const reply = trial.reply.trim();
  return (
    <div className="border-border/70 mt-1 flex flex-col gap-1 rounded-lg border px-3 py-2 text-xs">
      <p className="text-muted-foreground">
        Last trial, {formatWhen(trial.at)}. Nothing ran or was sent.
      </p>
      {trial.error !== null ? (
        <p className="text-destructive">Couldn't run the trial: {trial.error}</p>
      ) : (
        <>
          {actions.length > 0 ? (
            <div>
              <p className="font-medium">Would have:</p>
              <ul className="list-disc pl-4">
                {actions.map((line, index) => (
                  <li key={index} className="break-words">
                    {line}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p>Would not have used any tools.</p>
          )}
          {reply !== "" && (
            <p className="line-clamp-4 break-words whitespace-pre-wrap">
              <span className="font-medium">Would have said: </span>
              {isNothingToReport(reply) ? "nothing to report" : reply}
            </p>
          )}
        </>
      )}
    </div>
  );
}

const latestAt = (job: CronJobInfo): number => job.trials?.at(-1)?.at ?? 0;

/** Try now, Go live and Pause/Resume for one schedule. */
export function ScheduleControls({
  job,
  onChanged,
}: {
  job: CronJobInfo;
  onChanged: () => Promise<void>;
}) {
  // The latest trial when Try was pressed: trying until a newer one lands.
  const [triedAfter, setTriedAfter] = useState<number | null>(null);
  const trying = triedAfter !== null && latestAt(job) <= triedAfter;
  const recurring = job.once === undefined || job.once === null;
  const act = (what: string, run: () => Promise<unknown>) => async () => {
    try {
      await run();
      await onChanged();
    } catch (cause) {
      notifyError(`Couldn't ${what}`, cause);
    }
  };
  const tryNow = async () => {
    setTriedAfter(latestAt(job));
    try {
      await api.tryCron(job.id);
    } catch (cause) {
      setTriedAfter(null);
      notifyError("Couldn't start the trial", cause);
    }
  };
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5">
      {recurring && (
        <Button variant="outline" size="sm" disabled={trying} onClick={() => void tryNow()}>
          {trying ? "Trying…" : "Try now"}
        </Button>
      )}
      {job.trial === true && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => void act("go live", () => api.patchCron(job.id, { trial: false }))()}
        >
          Go live
        </Button>
      )}
      <Button
        variant="ghost"
        size="sm"
        onClick={() =>
          void act(job.enabled ? "pause" : "resume", () =>
            api.patchCron(job.id, { enabled: !job.enabled }),
          )()
        }
      >
        {job.enabled ? "Pause" : "Resume"}
      </Button>
    </div>
  );
}
