/**
 * "New bot", without a trigger of its own (the bot pill, the Crew page and
 * a department page drive it). With departments it asks "Which
 * department?", preset to the department it was opened from.
 */
import { useEffect, useState } from "react";
import { BotDialog, createBot, emptyForm } from "@/components/bot-dialog";
import { HomeSelect } from "@/components/department/home-select";
import { useApp } from "@/lib/app-state";
import { loadOrg } from "@/lib/use-org";

export function NewBotDialog({
  open,
  onOpenChange,
  onCreated,
  departmentId = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (id: string) => Promise<void>;
  /** The home to preset; null = the org. */
  departmentId?: string | null;
}) {
  const { sessions } = useApp();
  const [home, setHome] = useState(departmentId ?? "");
  useEffect(() => {
    if (open) setHome(departmentId ?? "");
  }, [open, departmentId]);
  return (
    <BotDialog
      title="New bot"
      initial={emptyForm}
      models={sessions.models}
      open={open}
      onOpenChange={onOpenChange}
      extra={
        <HomeSelect
          label="Which department?"
          value={home}
          onChange={setHome}
          hint="It follows its department's Instructions. Host access starts off."
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
