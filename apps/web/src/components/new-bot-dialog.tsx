/**
 * "New bot", without a trigger of its own (the bot pill, the Crew page and
 * a team page drive it). With teams it asks "Which
 * team?", preset to the team it was opened from.
 */
import { useEffect, useState } from "react";
import { BotDialog, createBot, emptyForm } from "@/components/bot-dialog";
import { HomeSelect } from "@/components/team/home-select";
import { useApp } from "@/lib/app-state";
import { loadOrg } from "@/lib/use-org";

export function NewBotDialog({
  open,
  onOpenChange,
  onCreated,
  teamId = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (id: string) => Promise<void>;
  /** The home to preset; null = the org. */
  teamId?: string | null;
}) {
  const { sessions } = useApp();
  const [home, setHome] = useState(teamId ?? "");
  useEffect(() => {
    if (open) setHome(teamId ?? "");
  }, [open, teamId]);
  return (
    <BotDialog
      title="New bot"
      initial={emptyForm}
      models={sessions.models}
      open={open}
      onOpenChange={onOpenChange}
      extra={
        <HomeSelect
          label="Which team?"
          value={home}
          onChange={setHome}
          hint="It follows its team's Instructions. Host access starts off."
        />
      }
      confirm={async (form) => {
        const id = await createBot(form, home === "" ? null : home);
        void loadOrg();
        await onCreated(id);
      }}
    />
  );
}
