/**
 * Skills: each bot's procedure library, and the evolution proposals parked
 * for the owner's decision. Reads the owner-scoped overview over REST; the
 * detail dialog holds one skill's full text and its open proposals.
 */
import { PowerIcon, PowerOffIcon, RotateCcwIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type {
  SkillDetail,
  SkillMeta,
  SkillOrigin,
  SkillOverview,
  SkillProposal,
} from "@ultiv/contracts";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { LazyMarkdown } from "@/components/lazy-markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { ListRow } from "@/components/ui/list-row";
import { SectionHeader } from "@/components/ui/section-header";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";
import { formatFull } from "@/lib/format";

const ORIGIN_LABEL: Record<SkillOrigin, string> = {
  builtin: "built-in",
  self: "self-written",
  owner: "owner",
  url: "installed",
};

const ORIGIN_VARIANT: Record<SkillOrigin, "secondary" | "default" | "outline"> = {
  builtin: "secondary",
  self: "default",
  owner: "outline",
  url: "outline",
};

/** One open skill in a bot's list, or a read-only built-in. */
function SkillRow({ skill, onOpen }: { skill: SkillMeta; onOpen: () => void }) {
  return (
    <ListRow
      leading={<Badge variant={ORIGIN_VARIANT[skill.origin]}>{ORIGIN_LABEL[skill.origin]}</Badge>}
      title={skill.name}
      subtitle={skill.description === "" ? undefined : skill.description}
      meta={`v${skill.version}`}
      onClick={onOpen}
    />
  );
}

/** The one-line identity under the dialog title: origin, version, last change. */
function describeMeta(meta: SkillMeta): string {
  const updated =
    meta.updatedAt === 0 ? "ships with the app" : `updated ${formatFull(meta.updatedAt)}`;
  return `${ORIGIN_LABEL[meta.origin]} · v${meta.version} · ${updated}`;
}

/** One parked change with its accept/reject pair. */
function ProposalCard({
  proposal,
  busy,
  onDecide,
}: {
  proposal: SkillProposal;
  busy: boolean;
  onDecide: (verdict: "accept" | "reject") => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-[14px] border p-3 text-sm">
      <p className="min-w-0 break-words">{proposal.note}</p>
      <p className="text-muted-foreground text-xs">
        Proposes a new version (base v{proposal.baseVersion})
      </p>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => onDecide("accept")}>
          Accept
        </Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => onDecide("reject")}>
          Reject
        </Button>
      </div>
    </div>
  );
}

/** The footer actions: enable, revert (when there is a parent), remove. */
function ActionRow({
  meta,
  busy,
  onToggle,
  onRevert,
  onDelete,
}: {
  meta: SkillMeta;
  busy: boolean;
  onToggle: () => void;
  onRevert: () => void;
  onDelete: () => Promise<void>;
}) {
  return (
    <div className="mt-4 flex items-center justify-between gap-2 border-t pt-3">
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          disabled={busy}
          aria-label={meta.enabled ? "Disable skill" : "Enable skill"}
          title={meta.enabled ? "Disable skill" : "Enable skill"}
          onClick={onToggle}
        >
          {meta.enabled ? <PowerIcon /> : <PowerOffIcon />}
        </Button>
        {meta.parentVersion !== null && (
          <Button
            variant="ghost"
            size="icon"
            disabled={busy}
            aria-label="Revert to the previous version"
            title="Revert to the previous version"
            onClick={onRevert}
          >
            <RotateCcwIcon />
          </Button>
        )}
        {meta.origin !== "builtin" && (
          <ConfirmDialog
            title={`Remove ${meta.name}?`}
            warning="The bot loses this procedure right away. This cannot be undone."
            confirmLabel="Remove skill"
            onConfirm={onDelete}
          >
            <Button
              variant="ghost"
              size="icon"
              disabled={busy}
              aria-label="Remove skill"
              title="Remove skill"
            >
              <Trash2Icon />
            </Button>
          </ConfirmDialog>
        )}
      </div>
      <Badge variant={meta.enabled ? "secondary" : "outline"}>
        {meta.enabled ? "enabled" : "disabled"}
      </Badge>
    </div>
  );
}

/** The detail dialog for one skill: its text, its proposals, its actions. */
function SkillDialog({
  target,
  onClose,
  reloadOverview,
}: {
  target: { profile: string; name: string };
  onClose: () => void;
  reloadOverview: () => Promise<void>;
}) {
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setDetail(await api.skill(target.profile, target.name));
      setLoadError(null);
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [target.profile, target.name]);
  useEffect(() => void load(), [load]);

  const act =
    (action: () => Promise<unknown>): (() => Promise<void>) =>
    async () => {
      setBusy(true);
      setError(null);
      try {
        await action();
        await load();
        await reloadOverview();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    };

  const decide = (proposal: SkillProposal, verdict: "accept" | "reject"): void => {
    void act(() => api.skillProposal(target.profile, proposal.id, verdict))();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogTitle>{target.name}</DialogTitle>
        {detail !== null && (
          <p className="text-muted-foreground mt-1 text-sm">{describeMeta(detail.meta)}</p>
        )}
        {loadError !== null ? (
          <div className="mt-3">
            <ErrorState
              message={`Couldn't load the skill: ${loadError}`}
              onRetry={() => void load()}
            />
          </div>
        ) : detail === null ? (
          <p className="text-muted-foreground mt-3 flex items-center gap-2 text-sm">
            <Spinner /> Loading…
          </p>
        ) : (
          <>
            <div className="mt-3 min-w-0 text-sm">
              <LazyMarkdown text={detail.body} />
            </div>
            {detail.proposals.length > 0 && (
              <div className="mt-5 flex flex-col gap-2">
                <SectionHeader title={`Proposals (${detail.proposals.length})`} />
                {detail.proposals.map((proposal) => (
                  <ProposalCard
                    key={proposal.id}
                    proposal={proposal}
                    busy={busy}
                    onDecide={(verdict) => decide(proposal, verdict)}
                  />
                ))}
              </div>
            )}
            {error !== null && (
              <div className="mt-3">
                <ErrorState message={error} />
              </div>
            )}
            <ActionRow
              meta={detail.meta}
              busy={busy}
              onToggle={() =>
                void act(() =>
                  api.skillSave(target.profile, target.name, {
                    enabled: !detail.meta.enabled,
                  }),
                )()
              }
              onRevert={() => void act(() => api.skillRevert(target.profile, target.name))()}
              onDelete={async () => {
                await api.skillRemove(target.profile, target.name);
                await reloadOverview();
                onClose();
              }}
            />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** A bot's namespace: its header and its skill rows (or its empty note). */
function NamespaceSection({
  namespace,
  onOpen,
}: {
  namespace: SkillOverview["profiles"][number];
  onOpen: (profile: string, name: string) => void;
}) {
  return (
    <section className="flex flex-col gap-2">
      <SectionHeader title={namespace.profileName} />
      {namespace.skills.length === 0 ? (
        <EmptyState>No skills yet. {namespace.profileName} writes them as work repeats.</EmptyState>
      ) : (
        <div className="divide-border/70 divide-y rounded-[14px] border">
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

  const load = useCallback(async () => {
    try {
      setOverview(await api.skills());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);
  useEffect(() => void load(), [load]);

  if (error !== null && overview === null) {
    return <ErrorState message={`Couldn't load skills: ${error}`} onRetry={() => void load()} />;
  }
  if (overview === null) {
    return (
      <p className="text-muted-foreground flex items-center gap-2 text-sm">
        <Spinner /> Loading skills…
      </p>
    );
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
            {overview.openProposals} open {overview.openProposals === 1 ? "proposal" : "proposals"}
          </Badge>
          <span className="text-muted-foreground">Open a skill to decide.</span>
        </p>
      )}
      {overview.profiles.map((namespace) => (
        <NamespaceSection
          key={namespace.profile}
          namespace={namespace}
          onOpen={(profile, name) => setTarget({ profile, name })}
        />
      ))}
      {overview.profiles.length === 0 && overview.builtins.length > 0 && (
        <section className="flex flex-col gap-2">
          <SectionHeader title="Built-in library" />
          <div className="divide-border/70 divide-y rounded-[14px] border">
            {overview.builtins.map((skill) => (
              <SkillRow key={skill.name} skill={skill} onOpen={() => undefined} />
            ))}
          </div>
        </section>
      )}
      {target !== null && (
        <SkillDialog target={target} onClose={() => setTarget(null)} reloadOverview={load} />
      )}
    </div>
  );
}
