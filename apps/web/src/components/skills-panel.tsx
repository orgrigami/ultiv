/**
 * Skills: each bot's procedure library, and the evolution proposals parked
 * for the owner's decision. Reads the owner-scoped overview over REST; the
 * detail dialog holds one skill's full text and its open proposals.
 */
import { PlusIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { SkillMeta, SkillOverview } from "@spriessen/contracts";
import { plural } from "@/lib/plural";
import { SkillAdd } from "@/components/skills-edit";
import { Mark } from "@/components/state-mark";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { ListRow } from "@/components/ui/list-row";
import { SectionHeader } from "@/components/ui/section-header";
import { SkeletonRows } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { useLiveRefresh } from "@/lib/use-live-refresh";

import { SkillDialog } from "./skill-dialog.tsx";

import { ORIGIN_LABEL, ORIGIN_VARIANT } from "./skill-origin.ts";

/** One open skill in a bot's list, or a read-only built-in. Status rides the row. */
function SkillRow({ skill, onOpen }: { skill: SkillMeta; onOpen: () => void }) {
  return (
    <ListRow
      leading={<Badge variant={ORIGIN_VARIANT[skill.origin]}>{ORIGIN_LABEL[skill.origin]}</Badge>}
      title={skill.name}
      subtitle={skill.description === "" ? undefined : skill.description}
      meta={<span className="readout">v{skill.version}</span>}
      onClick={onOpen}
      trailing={
        <span
          className="text-muted-foreground flex w-14 shrink-0 items-center justify-end gap-1.5 pr-0.5 text-xs"
          title={skill.enabled ? "Enabled: the bot can load it" : "Disabled: the bot can't load it"}
        >
          <Mark
            kind={skill.enabled ? "done" : "disabled"}
            tone={skill.enabled ? "ok" : "muted"}
            className="size-3"
          />
          {skill.enabled ? "on" : "off"}
        </span>
      }
      className={skill.enabled ? "pr-2.5" : "pr-2.5 opacity-70"}
    />
  );
}

/** A bot's namespace: its header and its skill rows (or its empty note). */
function NamespaceSection({
  namespace,
  onOpen,
  onAdd,
  onCurate,
  curating,
}: {
  namespace: SkillOverview["profiles"][number];
  onOpen: (profile: string, name: string) => void;
  onAdd: (profile: string) => void;
  onCurate: (profile: string) => void;
  curating: boolean;
}) {
  return (
    <section className="flex flex-col gap-2">
      <SectionHeader
        title={namespace.profileName}
        action={
          <span className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              disabled={curating}
              aria-label={`Find overlapping skills for ${namespace.profileName}`}
              onClick={() => onCurate(namespace.profile)}
            >
              Find overlaps
            </Button>
            <Button
              size="sm"
              aria-label={`Add skill for ${namespace.profileName}`}
              onClick={() => onAdd(namespace.profile)}
            >
              <PlusIcon /> Add skill
            </Button>
          </span>
        }
      />
      {namespace.skills.length === 0 ? (
        <EmptyState>No skills yet. {namespace.profileName} writes them as work repeats.</EmptyState>
      ) : (
        <div className="divide-border/70 divide-y rounded-xl border">
          {namespace.skills.map((skill) => (
            <SkillRow
              key={skill.name}
              skill={skill}
              onOpen={() => onOpen(namespace.profile, skill.name)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/** The Skills content, shown on the /skills page. */
export function SkillsContent() {
  const [overview, setOverview] = useState<SkillOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<{ profile: string; name: string } | null>(null);
  const [addingFor, setAddingFor] = useState<string | null>(null);
  const [curatingFor, setCuratingFor] = useState<string | null>(null);
  const [curateNote, setCurateNote] = useState<{ profileName: string; parked: number } | null>(
    null,
  );

  const load = useCallback(async () => {
    try {
      setOverview(await api.skills());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);
  useEffect(() => void load(), [load]);
  // Bots save, learn and propose skills on their own.
  useLiveRefresh(["skills"], load);

  const curate = useCallback(
    async (profile: string) => {
      const profileName =
        overview?.profiles.find((namespace) => namespace.profile === profile)?.profileName ??
        profile;
      setCuratingFor(profile);
      try {
        const parked = (await api.skillCurate(profile)).proposals.length;
        setCurateNote({ profileName, parked });
        await load();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setCuratingFor(null);
      }
    },
    [overview, load],
  );

  if (error !== null && overview === null) {
    return <ErrorState message={`Couldn't load skills: ${error}`} onRetry={() => void load()} />;
  }
  if (overview === null) {
    return <SkeletonRows label="Loading skills" />;
  }
  if (overview.profiles.length === 0 && overview.builtins.length === 0) {
    return (
      <EmptyState>
        No skills yet. A few ship with the app, and bots write their own as work repeats.
      </EmptyState>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      {overview.openProposals > 0 && (
        <p className="flex items-center gap-2 text-sm">
          <Badge>
            {overview.openProposals} open {plural(overview.openProposals, "proposal", "proposals")}
          </Badge>
          <span className="text-muted-foreground">Open a skill to decide.</span>
        </p>
      )}
      {curateNote !== null && (
        <p className="flex items-center gap-2 text-sm">
          {curateNote.parked > 0 ? (
            <>
              <Badge>
                {curateNote.parked} {plural(curateNote.parked, "overlap", "overlaps")} for{" "}
                {curateNote.profileName}
              </Badge>
              <span className="text-muted-foreground">Open a skill to decide.</span>
            </>
          ) : (
            <span className="text-muted-foreground">
              No overlapping skills found for {curateNote.profileName}.
            </span>
          )}
        </p>
      )}
      {overview.profiles.map((namespace) => (
        <NamespaceSection
          key={namespace.profile}
          namespace={namespace}
          onOpen={(profile, name) => setTarget({ profile, name })}
          onAdd={(profile) => setAddingFor(profile)}
          onCurate={(profile) => void curate(profile)}
          curating={curatingFor === namespace.profile}
        />
      ))}
      {overview.profiles.length === 0 && overview.builtins.length > 0 && (
        <section className="flex flex-col gap-2">
          <SectionHeader title="Built-in library" />
          <div className="divide-border/70 divide-y rounded-xl border">
            {overview.builtins.map((skill) => (
              <SkillRow key={skill.name} skill={skill} onOpen={() => undefined} />
            ))}
          </div>
        </section>
      )}
      {target !== null && (
        <SkillDialog target={target} onClose={() => setTarget(null)} reloadOverview={load} />
      )}
      {addingFor !== null && (
        <SkillAdd profile={addingFor} onSaved={load} onClose={() => setAddingFor(null)} />
      )}
    </div>
  );
}
