/**
 * The bot's background model: what its tasks and background routines run
 * on. Saves on change (like the always-allowed list), so it sits beside the
 * Edit-bot form rather than inside it. Empty = the workspace's background
 * model when the server sets one, else the bot's chat model.
 */
import { useState } from "react";
import type { ModelInfo, ProfileInfo } from "@spriessen/contracts";
import { ModelFields } from "@/components/bot-fields";
import { api } from "@/lib/api";

export function BackgroundModelField({
  bot,
  models,
  refresh,
}: {
  bot: ProfileInfo;
  models: ModelInfo[];
  refresh: () => Promise<void>;
}) {
  const stored = bot.policies.backgroundModel ?? null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (id: string, effort: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.updateProfile(bot.id, {
        policies: { ...bot.policies, backgroundModel: id === "" ? null : { id, effort } },
      });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-1 text-sm">
      <ModelFields
        label="Background model"
        emptyLabel="Same as chat (or the workspace's background model)"
        modelId={stored?.id ?? ""}
        effort={stored?.effort ?? ""}
        onModel={(id) => void save(id, "")}
        onEffort={(effort) => void save(stored?.id ?? "", effort)}
        models={models}
        disabled={busy}
      />
      <span className="text-muted-foreground text-xs">
        Tasks this bot starts and routines that run in the background use this model. A cheaper one
        keeps background work cheap. Saved as soon as you pick.
      </span>
      {error !== null && (
        <span role="alert" className="text-destructive text-xs">
          {error}
        </span>
      )}
    </div>
  );
}
