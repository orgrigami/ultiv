/**
 * The workspace default for how many background tasks a bot runs at once
 * (GET /api/settings/tasks), read when a surface that shows it opens.
 */
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

/** The default number, once loaded (undefined until then, or when it failed). */
export function useTaskDefault(enabled = true): number | undefined {
  const [value, setValue] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    api.settingsTasks().then(
      (settings) => live && setValue(settings.maxRunningTasks),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [enabled]);
  return value;
}
