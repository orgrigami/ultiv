/**
 * A department's settings in one card: its name, standing Instructions and
 * VM size (one Save), and its host-access switch (applies at once, and
 * says when the org switch blocks it anyway).
 */
import { useEffect, useState } from "react";
import type { DepartmentInfo } from "@spriessen/contracts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { orgApi } from "@/lib/org-api";
import { readVmInput } from "@/lib/org-view";
import { VmFields } from "./vm-fields";

const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export function DeptSettings({
  department,
  orgHostAccess,
}: {
  department: DepartmentInfo;
  orgHostAccess: boolean;
}) {
  const [name, setName] = useState(department.name);
  const [instructions, setInstructions] = useState(department.instructions);
  const [cpus, setCpus] = useState(String(department.vm.cpus));
  const [memory, setMemory] = useState(String(department.vm.memoryMiB));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    setName(department.name);
    setInstructions(department.instructions);
    setCpus(String(department.vm.cpus));
    setMemory(String(department.vm.memoryMiB));
  }, [department]);
  const vm = readVmInput(cpus, memory);
  const dirty =
    name.trim() !== department.name ||
    instructions !== department.instructions ||
    (typeof vm !== "string" &&
      (vm.cpus !== department.vm.cpus || vm.memoryMiB !== department.vm.memoryMiB));
  const run = async (patch: Parameters<typeof orgApi.patchDepartment>[1], done: string) => {
    setBusy(true);
    setNote(null);
    try {
      await orgApi.patchDepartment(department.id, patch);
      setNote({ ok: true, text: done });
    } catch (cause) {
      setNote({ ok: false, text: errorText(cause) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="bg-card divide-border flex flex-col divide-y rounded-xl border">
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
          checked={department.hostAccess}
          disabled={busy}
          onCheckedChange={(checked) =>
            void run(
              { hostAccess: checked === true },
              checked === true ? "Host access on." : "Host access off.",
            )
          }
        />
        <span className="text-ui">
          Host access for this department
          <span className="text-meta text-muted-foreground block">
            {!department.hostAccess
              ? "Off. Its bots can't run things on this computer."
              : orgHostAccess
                ? "On. A bot here still needs its own switch on (its Access tab)."
                : "On here, but the org switch is off, so it has no effect (Settings → Organization)."}
          </span>
        </span>
      </label>
    </div>
  );
}
