/**
 * A department's shared memory: the facts its bots share, and the share
 * proposals waiting for the owner (a bot offers one of its own facts; you
 * accept it into the shared store or turn it down).
 */
import { CheckIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { SkeletonRows } from "@/components/ui/skeleton";
import { orgApi, type SharedMemory } from "@/lib/org-api";

const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export function DeptMemory({ departmentId }: { departmentId: string }) {
  const [memory, setMemory] = useState<SharedMemory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async (): Promise<void> => {
    try {
      setMemory(await orgApi.sharedMemory(departmentId));
      setError(null);
    } catch (cause) {
      setError(errorText(cause));
    }
  }, [departmentId]);
  useEffect(() => {
    void load();
  }, [load]);
  if (error !== null && memory === null)
    return <ErrorState message={error} onRetry={() => void load()} />;
  if (memory === null) return <SkeletonRows label="Shared memory" rows={2} />;
  const open = memory.proposals.filter((row) => row.kind === "share" && row.status === "open");
  const decide = async (id: string, accept: boolean): Promise<void> => {
    setBusy(id);
    try {
      await orgApi.decideShare(departmentId, id, accept);
      await load();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="bg-card divide-border flex flex-col divide-y rounded-xl border">
      {open.map((proposal) => (
        <div key={proposal.id} className="flex items-center gap-2 px-3 py-2.5">
          <span className="text-ui min-w-0 flex-1">
            <span className="text-meta text-signal block">Wants to share</span>
            <span className="block">{proposal.summary}</span>
          </span>
          <Button
            size="icon-sm"
            variant="outline"
            aria-label="Turn down"
            disabled={busy !== null}
            onClick={() => void decide(proposal.id, false)}
          >
            <XIcon />
          </Button>
          <Button
            size="icon-sm"
            aria-label="Share it"
            disabled={busy !== null}
            onClick={() => void decide(proposal.id, true)}
          >
            <CheckIcon />
          </Button>
        </div>
      ))}
      {memory.facts.length === 0 && open.length === 0 ? (
        <EmptyState className="px-3 py-2.5">
          Nothing shared yet. A bot here can offer a fact to share; you decide here.
        </EmptyState>
      ) : (
        memory.facts.slice(0, 6).map((fact) => (
          <p key={fact.id} className="text-ui px-3 py-2.5">
            {fact.text}
          </p>
        ))
      )}
      {memory.facts.length > 6 && (
        <p className="text-meta text-muted-foreground px-3 py-2">
          and {memory.facts.length - 6} more shared facts
        </p>
      )}
      {error !== null && <ErrorState className="m-2" message={error} />}
    </div>
  );
}
