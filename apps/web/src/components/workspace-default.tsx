/**
 * Settings › Workspace default model: the model new chats (and bots saved on
 * "Workspace default") start on. The stored setting ("set here") outranks the
 * server's SPRIESSEN_MODEL environment ("from environment"); with neither, no
 * default exists and new chats have no model until one is set. Save PUTs the
 * picked ref (or null to clear and hand the default back to the environment).
 */
import { useCallback, useEffect, useState } from "react";
import type { ModelInfo, WorkspaceDefaultModel } from "@spriessen/contracts";
import { ModelOptions } from "@/components/model-options";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/empty-state";
import { SectionHeader } from "@/components/ui/section-header";
import { Select } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";

const card = "bg-card divide-border flex flex-col divide-y rounded-xl border";

const SOURCE_LABEL: Record<WorkspaceDefaultModel["source"], string> = {
  db: "set here",
  env: "from the server's environment",
};

function WorkspaceDefaultSection() {
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [current, setCurrent] = useState<WorkspaceDefaultModel | null>(null);
  const [loadError, setLoadError] = useState(false);
  // The draft: "" = not set (stored default cleared on save).
  const [ref, setRef] = useState("");
  const [effort, setEffort] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async (): Promise<void> => {
    try {
      const [payload, settings] = await Promise.all([api.models(), api.settingsModel()]);
      setModels(payload.models);
      setCurrent(settings.defaultModel);
      // The draft follows the STORED setting; the env default is only shown
      // as the effective readout, never as something this page can edit.
      setRef(settings.defaultModel?.source === "db" ? settings.defaultModel.ref : "");
      setEffort(settings.defaultModel?.source === "db" ? settings.defaultModel.effort : "");
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
      await api.setSettingsModel(ref === "" ? null : { ref, effort: effort === "" ? "" : effort });
      setCurrent((await api.settingsModel()).defaultModel);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const effective =
    current !== null
      ? `${current.ref}${current.effort !== "" ? ` (${current.effort})` : ""} — ${SOURCE_LABEL[current.source]}`
      : "not set: new chats have no model until one is set here or in the server's environment";
  return (
    <section aria-label="Workspace default model" className="flex flex-col gap-2">
      <SectionHeader title="Workspace default model" />
      {loadError && models === null ? (
        <div className={card}>
          <div className="px-3 py-2.5">
            <ErrorState
              message="Couldn't load the workspace default."
              onRetry={() => void reload()}
            />
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
              <span className="text-muted-foreground text-xs" title={effective}>
                Current default: {effective}
              </span>
              <Button size="sm" disabled={busy} onClick={() => void save()}>
                {busy && <Spinner />}
                Save
              </Button>
            </div>
          </div>
          <p className="text-muted-foreground max-w-[56ch] text-xs">
            The stored setting outranks the server's SPRIESSEN_MODEL environment. Clearing it hands
            the default back to the environment; with neither set, new chats fail until a model is
            picked per chat.
          </p>
          {error !== null && <ErrorState message={error} />}
        </>
      )}
    </section>
  );
}

export { WorkspaceDefaultSection };
