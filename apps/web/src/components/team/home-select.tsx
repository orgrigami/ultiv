/**
 * "Which team?": a native select of homes, the org first. It hides
 * itself while there are no teams (personal mode: every bot is an
 * org bot), unless the value names one that isn't there. The value is a
 * team id, "" for the org; a name (a bot's proposal) is matched too.
 */
import { Select } from "@/components/ui/select";
import { useOrg } from "@/lib/use-org";

export const matchHome = (
  value: string,
  teams: readonly { id: string; name: string }[],
): string | null => {
  if (value === "" || value === "org") return "";
  const wanted = value.trim().toLocaleLowerCase("en");
  return (
    teams.find((row) => row.id === value || row.name.toLocaleLowerCase("en") === wanted)?.id ?? null
  );
};

export function HomeSelect({
  label,
  value,
  onChange,
  lockedReason,
  hint,
}: {
  label: string;
  value: string;
  onChange: (teamId: string) => void;
  /** Why the home can't change (the main bot); shown instead of choices. */
  lockedReason?: string | undefined;
  hint?: string | undefined;
}) {
  const { view } = useOrg();
  const teams = [...(view?.teams ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const matched = matchHome(value, teams);
  if (teams.length === 0 && matched === "") return null;
  const orgName = view?.org?.name ?? "Org";
  return (
    <label className="flex flex-col gap-1 text-sm">
      {label}
      <Select
        value={matched ?? value}
        disabled={lockedReason !== undefined}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{orgName} (no team)</option>
        {teams.map((row) => (
          <option key={row.id} value={row.id}>
            {row.name}
          </option>
        ))}
        {matched === null && <option value={value}>{value} (not found)</option>}
      </Select>
      {(lockedReason ?? hint) !== undefined && (
        <span className="text-muted-foreground text-xs">{lockedReason ?? hint}</span>
      )}
    </label>
  );
}
