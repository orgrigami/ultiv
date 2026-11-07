/**
 * The Access tab's summary card: what a bot can actually do here, a line
 * per area with a state mark and, when something is off elsewhere, where to
 * change it (lib/effective-access.ts). Reads the server check, the
 * host-access matrix and the vault bindings once per bot.
 */
import { useEffect, useState } from "react";
import type { CredentialBinding, ProfileInfo } from "@spriessen/contracts";
import { Mark, type MarkKind, type MarkTone } from "@/components/state-mark";
import { SectionHeader } from "@/components/ui/section-header";
import { api } from "@/lib/api";
import {
  ALWAYS_ASKS,
  effectiveAccess,
  type AccessInput,
  type AccessTone,
} from "@/lib/effective-access";
import { orgApi } from "@/lib/org-api";

type Loaded = Omit<AccessInput, "bot">;

const settle = <T,>(promise: Promise<T>): Promise<T | null> => promise.catch(() => null);

function useAccessInputs(botId: string): Loaded {
  const [loaded, setLoaded] = useState<Loaded>({ microvm: null, host: null, bindings: null });
  useEffect(() => {
    let live = true;
    void Promise.all([
      settle(api.serverCheck()),
      settle(orgApi.hostAccess()),
      settle(api.bindings()),
    ]).then(([check, matrix, bindings]) => {
      if (!live) return;
      const row = matrix?.bots.find((candidate) => candidate.profileId === botId) ?? null;
      setLoaded({
        microvm: check?.microvm.available ?? null,
        host: row,
        bindings: bindings as CredentialBinding[] | null,
      });
    });
    return () => {
      live = false;
    };
  }, [botId]);
  return loaded;
}

const MARK: Record<AccessTone, { kind: MarkKind; tone: MarkTone }> = {
  on: { kind: "done", tone: "ok" },
  asks: { kind: "pending", tone: "ink" },
  off: { kind: "disabled", tone: "muted" },
};

export function EffectiveAccess({ bot }: { bot: ProfileInfo }) {
  const loaded = useAccessInputs(bot.id);
  const lines = effectiveAccess({ bot, ...loaded });
  return (
    <section aria-label={`What ${bot.name} can do here`} className="flex flex-col gap-2">
      <SectionHeader title={`What ${bot.name} can do here`} />
      <dl className="bg-card divide-border divide-y rounded-xl border">
        {lines.map((line) => (
          <div key={line.label} className="flex items-start gap-2.5 px-3 py-2.5">
            <Mark {...MARK[line.tone]} className="mt-1 size-3 shrink-0" />
            <dt className="w-28 shrink-0 text-sm font-medium">{line.label}</dt>
            <dd className="text-muted-foreground min-w-0 flex-1 text-sm">
              {line.text}
              {line.fix !== undefined && (
                <span className="block text-xs">Change it in {line.fix}.</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
      <p className="text-muted-foreground text-xs">{ALWAYS_ASKS}</p>
    </section>
  );
}
