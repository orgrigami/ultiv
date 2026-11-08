/**
 * Settings › Fallback model: the one rescue attempt a FAILED background
 * task gets. When a task run fails and this is set, the task's conversation
 * switches to it for one more attempt (the overnight story: a provider
 * dying at 3am no longer parks every run), then back to its own model.
 * Chats with the owner never fall over silently. Not set = failed stays
 * failed and lands in Needs you.
 */
import { useCallback, useEffect, useState } from "react";
import type { ModelInfo } from "@spriessen/contracts";
import { ModelOptions } from "@/components/model-options";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/empty-state";
import { SectionHeader } from "@/components/ui/section-header";
import { Select } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";

const card = "bg-card divide-border flex flex-col divide-y rounded-xl border";

export function WorkspaceFallbackSection() {
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [current, setCurrent] = useState<{ ref: string; effort: string } | null>(null);
  const [ref, setRef] = useState("");
  const [effort, setEffort] = useState("");
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async (): Promise<void> => {
    try {
      const [payload, settings] = await Promise.all([api.models(), api.settingsFallback()]);
      setModels(payload.models);
      setCurrent(settings.fallbackModel);
      setRef(settings.fallbackModel?.ref ?? "");
      setEffort(settings.fallbackModel?.effort ?? "");
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);
  useEffect(() => void reload(), [reload]);
  const efforts = models?.find((model) => model.id === ref)?.efforts ?? [];
  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const saved = await api.setSettingsFallback(
        ref === "" ? null : { ref, effort: effort === "" ? "" : effort },
      );
      setCurrent(saved.fallbackModel);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Fallback model" className="flex flex-col gap-2">
      <SectionHeader title="Fallback model" />
      {loadError && models === null ? (
        <div className={card}>
          <div className="px-3 py-2.5">
            <ErrorState message="Couldn't load the fallback model." onRetry={() => void reload()} />
          </div>
        </div>
      ) : models === null ? (
        <div className={card}>
          <div className="text-muted-foreground flex items-center gap-2 px-3 py-2.5 text-xs">
            <Spinner /> Loading models…
          </div>
        </div>
      ) : (
        <>
          <div className={card}>
            <div className="flex flex-col gap-3 px-3 py-3 sm:flex-row">
              <label className="flex flex-1 flex-col gap-1 text-sm">
                Model
                <Select
                  className="w-full"
                  value={ref}
                  onChange={(event) => {
                    setRef(event.target.value);
                    setEffort("");
                  }}
                >
                  <option value="">Not set</option>
                  <ModelOptions models={models} />
                </Select>
              </label>
              <label
                className="flex flex-1 flex-col gap-1 text-sm"
                title={efforts.length === 0 ? "Pick a model with effort levels first" : undefined}
              >
                Thinking effort
                <Select
                  className="w-full"
                  value={effort}
                  disabled={ref === "" || efforts.length === 0}
                  onChange={(event) => setEffort(event.target.value)}
                >
                  <option value="">Model default</option>
                  {efforts.map((level) => (
                    <option key={level} value={level}>
                      {level}
                    </option>
                  ))}
                </Select>
              </label>
            </div>
            <div className="flex items-center justify-between gap-3 px-3 py-2.5">
              <span className="text-muted-foreground text-xs">
                {current === null
                  ? "Not set: a failed task stays failed and lands in Needs you."
                  : `Failed tasks retry once on ${current.ref}.`}
              </span>
              <Button size="sm" disabled={busy} onClick={() => void save()}>
                {busy && <Spinner />}
                Save
              </Button>
            </div>
          </div>
          <p className="text-muted-foreground text-xs">
            A failed background task tries once more on this model, then its own model returns.
            Useful as a second provider, so one outage never stops the crew overnight.
          </p>
          {error !== null && <ErrorState message={error} />}
        </>
      )}
    </section>
  );
}
