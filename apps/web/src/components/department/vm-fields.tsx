/** The VM size as two number fields, the problem (if any) under them. */
import { Input } from "@/components/ui/input";
import { readVmInput } from "@/lib/org-view";

export function VmFields({
  cpus,
  memory,
  onCpus,
  onMemory,
}: {
  cpus: string;
  memory: string;
  onCpus: (value: string) => void;
  onMemory: (value: string) => void;
}) {
  const vm = readVmInput(cpus, memory);
  return (
    <fieldset className="flex flex-col gap-1 text-sm">
      <legend className="mb-1">VM size</legend>
      <div className="flex gap-2">
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-muted-foreground text-xs">CPUs</span>
          <Input
            inputMode="numeric"
            value={cpus}
            aria-invalid={typeof vm === "string" && vm.startsWith("CPUs")}
            onChange={(event) => onCpus(event.target.value)}
          />
        </label>
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-muted-foreground text-xs">Memory (MiB)</span>
          <Input
            inputMode="numeric"
            value={memory}
            aria-invalid={typeof vm === "string" && vm.startsWith("Memory")}
            onChange={(event) => onMemory(event.target.value)}
          />
        </label>
      </div>
      <span
        className={
          typeof vm === "string" ? "text-destructive text-xs" : "text-muted-foreground text-xs"
        }
      >
        {typeof vm === "string" ? vm : "Shared by its bots once VMs start (Phase 4)."}
      </span>
    </fieldset>
  );
}
