/**
 * The bots panel: every bot as a row (avatar, name, role, model) that opens
 * its main chat, with the row's "…" menu for memory, edit, make-main, hide
 * and delete; "New bot" opens the shared bot form. Hidden bots sort last
 * under their own label.
 */
import { Fragment, useState } from "react";
import { BotDialog, createBot, emptyForm } from "@/components/bot-dialog";
import { BotRow } from "@/components/bot-row";
import { Button } from "@/components/ui/button";
import { SectionHeader } from "@/components/ui/section-header";
import { ErrorState } from "@/components/ui/empty-state";
import { useApp } from "@/lib/app-state";
import type { ModelInfo, ProfileInfo } from "@spreissen/contracts";

export function BotsPanel({
  profiles,
  models,
  activeId,
  mainId,
  refresh,
  onOpenMain,
}: {
  profiles: ProfileInfo[];
  models: ModelInfo[];
  /** The bot whose chat is on screen (null = none). */
  activeId: string | null;
  mainId: string | null;
  refresh: () => Promise<void>;
  onOpenMain: (profileId: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  // Which bots have a gate waiting on the owner (polled app-wide).
  const { attention } = useApp();

  const act = async (run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
      setError(null);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  // Hidden bots sort to the bottom under their own label — out of the way,
  // never out of reach.
  const ordered = [...profiles].sort(
    (a, b) => (a.archivedAt === null ? 0 : 1) - (b.archivedAt === null ? 0 : 1),
  );

  return (
    <section aria-label="Bots" className="flex flex-col gap-2">
      <SectionHeader
        title="Roster"
        action={
          <BotDialog
            title="New bot"
            initial={emptyForm}
            models={models}
            confirm={async (form) => {
              await createBot(form);
              await refresh();
            }}
          >
            <Button variant="outline" size="sm">
              New bot
            </Button>
          </BotDialog>
        }
      />
      {error !== null && <ErrorState message={error} />}
      {ordered.length > 0 && (
        <ul className="divide-border divide-y rounded-xl border">
          {ordered.map((bot, index) => (
            <Fragment key={bot.id}>
              {bot.archivedAt !== null && ordered[index - 1]?.archivedAt === null && (
                <li className="bg-muted/30 px-3 pt-3 pb-1">
                  <SectionHeader title="Hidden" />
                </li>
              )}
              <BotRow
                bot={bot}
                active={bot.id === activeId}
                mainId={mainId}
                deletable={ordered.length > 1}
                needsYou={attention.has(bot.id)}
                models={models}
                act={act}
                refresh={refresh}
                onOpenMain={onOpenMain}
              />
            </Fragment>
          ))}
        </ul>
      )}
    </section>
  );
}
