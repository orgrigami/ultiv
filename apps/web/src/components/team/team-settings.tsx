/**
 * A team's settings in one card: its name, standing Instructions and
 * VM size (one Save), and its host-access switch (applies at once, and
 * says when the org switch blocks it anyway).
 */
import { useEffect, useState } from "react";
import type { TeamInfo } from "@spriessen/contracts";
import { Button } from "@/components/ui/button";
import { ListCard } from "@/components/ui/list-card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { orgApi } from "@/lib/org-api";
import { readVmInput } from "@/lib/org-view";
import { NetAllowlistEditor } from "@/components/net-allowlist";
import { VmFields } from "./vm-fields";

const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export function TeamSettings({ team, orgHostAccess }: { team: TeamInfo; orgHostAccess: boolean }) {
  const [name, setName] = useState(team.name);
  const [instructions, setInstructions] = useState(team.instructions);
  const [cpus, setCpus] = useState(String(team.vm.cpus));
  const [memory, setMemory] = useState(String(team.vm.memoryMiB));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    setName(team.name);
    setInstructions(team.instructions);
    setCpus(String(team.vm.cpus));
    setMemory(String(team.vm.memoryMiB));
  }, [team]);
  const vm = readVmInput(cpus, memory);
  const dirty =
    name.trim() !== team.name ||
    instructions !== team.instructions ||
    (typeof vm !== "string" && (vm.cpus !== team.vm.cpus || vm.memoryMiB !== team.vm.memoryMiB));
  const run = async (patch: Parameters<typeof orgApi.patchTeam>[1], done: string) => {
    setBusy(true);
    setNote(null);
    try {
      await orgApi.patchTeam(team.id, patch);
      setNote({ ok: true, text: done });
    } catch (cause) {
      setNote({ ok: false, text: errorText(cause) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <ListCard>
      <form
        className="flex flex-col gap-3 p-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (typeof vm === "string" || name.trim() === "") return;
          void run({ name: name.trim(), instructions, vm }, "Saved.");
        }}
      >
        <label className="flex flex-col gap-1 text-sm">
          Name
          <Input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Instructions
          <Textarea
            rows={5}
            value={instructions}
            placeholder="Standing rules every bot here follows, before its own Instructions."
            onChange={(event) => setInstructions(event.target.value)}
          />
        </label>
        <VmFields cpus={cpus} memory={memory} onCpus={setCpus} onMemory={setMemory} />
        <div className="flex items-center justify-end gap-3">
          {note !== null && (
            <span
              role={note.ok ? "status" : "alert"}
              className={note.ok ? "text-ok text-sm" : "text-destructive text-sm"}
            >
              {note.text}
            </span>
          )}
          <Button
            type="submit"
            size="sm"
            disabled={busy || !dirty || typeof vm === "string" || name.trim() === ""}
          >
            Save
          </Button>
        </div>
      </form>
      <label className="flex cursor-pointer items-start gap-3 px-3 py-2.5">
        <Checkbox
          className="mt-0.5"
          checked={team.hostAccess}
          disabled={busy}
          onCheckedChange={(checked) =>
            void run(
              { hostAccess: checked === true },
              checked === true ? "Host access on." : "Host access off.",
            )
          }
        />
        <span className="text-ui">
          Host access for this team
          <span className="text-meta text-muted-foreground block">
            {!team.hostAccess
              ? "Off. Its bots can't run things on this computer."
              : orgHostAccess
                ? "On. A bot here still needs its own switch on (its Access tab)."
                : "On here, but the org switch is off, so it has no effect (Settings → Organization)."}
          </span>
        </span>
      </label>
      <NetAllowlistEditor
        title="Team VM network"
        entries={team.netAllowlist ?? []}
        open={team.netOpen === true}
        meta={
          team.netOpen === true
            ? "Open: this VM reaches everything. The allowlist below is ignored until you close it again."
            : team.netAllowlist === undefined || team.netAllowlist.length === 0
              ? "Offline: this VM reaches no hosts. Add the ones its bots need."
              : `This VM reaches exactly these hosts (${team.netAllowlist.length} of at most 64).`
        }
        onSave={async (draft, open) => {
          await orgApi.patchTeam(team.id, { netAllowlist: draft, netOpen: open });
        }}
      />
    </ListCard>
  );
}
