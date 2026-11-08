/**
 * Settings › Background tasks: how many tasks a bot runs at once unless its
 * own Edit bot says otherwise. Bots' chats hand all their work to tasks, so
 * this is how much of it moves at the same time; more wait in the bot's
 * queue. Saved on pick; "Built-in" clears the stored value (the server's
 * SPRIESSEN_MAX_RUNNING_TASKS, else 3).
 */
import { useCallback, useEffect, useState } from "react";
import { TASK_LIMIT_MAX, type TaskSettings } from "@spriessen/contracts";
import { ErrorState } from "@/components/ui/empty-state";
import { SectionHeader } from "@/components/ui/section-header";
import { Select } from "@/components/ui/select";
import { SkeletonRows } from "@/components/ui/skeleton";
import { api } from "@/lib/api";

const card = "bg-card flex flex-col rounded-xl border";

const SOURCE_LABEL: Record<TaskSettings["source"], string> = {
  db: "set here",
  env: "from the server's environment",
  default: "built in",
};

const CHOICES = Array.from({ length: TASK_LIMIT_MAX }, (_, index) => index + 1);

export function TaskDefaultSection() {
  const [current, setCurrent] = useState<TaskSettings | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reload = useCallback(async (): Promise<void> => {
    try {
      setCurrent(await api.settingsTasks());
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);
  useEffect(() => void reload(), [reload]);
  const pick = async (value: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setCurrent(await api.setSettingsTasks(value === "" ? null : Number(value)));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Background tasks" className="flex flex-col gap-2">
      <SectionHeader title="Background tasks" />
      {loadError && current === null ? (
        <ErrorState message="Couldn't load the task setting." onRetry={() => void reload()} />
      ) : current === null ? (
        <SkeletonRows label="Loading the task setting" rows={1} />
      ) : (
        <div className={card}>
          <label className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm">
            <span className="flex min-w-0 flex-col gap-0.5">
              Tasks at once, per bot
              <span className="text-muted-foreground text-xs">
                Now {current.maxRunningTasks} — {SOURCE_LABEL[current.source]}
              </span>
            </span>
            <Select
              className="w-36 shrink-0"
              value={current.source === "db" ? String(current.maxRunningTasks) : ""}
              disabled={busy}
              onChange={(event) => void pick(event.target.value)}
            >
              <option value="">Built-in</option>
              {CHOICES.map((count) => (
                <option key={count} value={String(count)}>
                  {count}
                </option>
              ))}
            </Select>
          </label>
        </div>
      )}
      <p className="text-muted-foreground text-xs">
        Bots' chats hand their work to background tasks. This many run at once per bot; more wait in
        its queue and start by themselves. A bot's own Edit bot setting outranks this.
      </p>
      {error !== null && <ErrorState message={error} />}
    </section>
  );
}
