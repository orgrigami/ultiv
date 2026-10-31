/**
 * New department: a name, optional standing Instructions and the VM size
 * its bots share. Host access starts off; the owner turns it on from the
 * department page. Opens the new department's page once it exists.
 */
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { DEFAULT_VM } from "@spriessen/contracts";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { orgApi } from "@/lib/org-api";
import { readVmInput } from "@/lib/org-view";
import { VmFields } from "./vm-fields";

export function NewDepartmentDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** After it exists; the default opens its page. */
  onCreated?: ((id: string) => void) | undefined;
}) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [cpus, setCpus] = useState(String(DEFAULT_VM.cpus));
  const [memory, setMemory] = useState(String(DEFAULT_VM.memoryMiB));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const vm = readVmInput(cpus, memory);
  const submit = async (): Promise<void> => {
    if (name.trim() === "" || typeof vm === "string") return;
    setBusy(true);
    setError(null);
    try {
      const created = await orgApi.createDepartment({
        name: name.trim(),
        vm,
        hostAccess: false,
        ...(instructions.trim() !== "" ? { instructions } : {}),
      });
      onOpenChange(false);
      setName("");
      setInstructions("");
      if (onCreated !== undefined) onCreated(created.id);
      else void navigate({ to: "/crew/dept/$departmentId", params: { departmentId: created.id } });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>New department</DialogTitle>
        <form
          className="mt-4 flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label className="flex flex-col gap-1 text-sm">
            Name
            <Input
              value={name}
              autoFocus
              maxLength={80}
              placeholder="Research"
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Instructions
            <Textarea
              rows={4}
              value={instructions}
              placeholder="Standing rules every bot in this department follows, before its own."
              onChange={(event) => setInstructions(event.target.value)}
            />
          </label>
          <VmFields cpus={cpus} memory={memory} onCpus={setCpus} onMemory={setMemory} />
          <p className="text-muted-foreground text-xs">
            Host access starts off: its bots can't run things on this computer until you switch it
            on from the department page.
          </p>
          {error !== null && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          <div className="flex justify-end">
            <Button type="submit" disabled={busy || name.trim() === "" || typeof vm === "string"}>
              {busy ? "Creating…" : "Create department"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
