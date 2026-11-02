/**
 * Stop one running task, with a light inline confirm ("Stop task" / "Keep") —
 * no dialog for something this small. Shared by the task pill rows and the
 * task sheet's header.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

export function StopTask({ id, onStopped }: { id: string; onStopped: () => void }) {
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stop = async (): Promise<void> => {
    try {
      await api.cancelTask(id);
      setAsking(false);
      onStopped();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  if (!asking)
    return (
      <Button variant="ghost" size="sm" className="shrink-0" onClick={() => setAsking(true)}>
        Stop
      </Button>
    );
  return (
    <span className="flex shrink-0 items-center gap-1">
      {error !== null && (
        <span role="alert" className="text-destructive text-xs">
          Couldn't stop
        </span>
      )}
      <Button variant="destructive" size="sm" onClick={() => void stop()}>
        Stop task
      </Button>
      <Button variant="ghost" size="sm" onClick={() => setAsking(false)}>
        Keep
      </Button>
    </span>
  );
}
