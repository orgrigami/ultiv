/**
 * People & things tab: the resolved entities (own + owner stores) with their
 * card sheet — type, aliases as chips, the facts that mention them. There is
 * no owner merge for entities, so the sheet shows no merge button (a
 * disabled one only advertised a feature that does not exist).
 */
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";
import { RowButton } from "@/components/ui/row-button";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import type { MemoryData } from "@/components/memory/memory-panel";
import type { MemoryV2Entity, MemoryV2Fact } from "@/lib/api";
import * as t from "@/lib/memory-text";

interface TabProps {
  data: MemoryData;
  name: string;
}

export function EntitiesTab({ data }: TabProps) {
  const seenIds = new Set<string>();
  const unique = data.entities.filter((entity) => {
    if (seenIds.has(entity.id)) return false;
    seenIds.add(entity.id);
    return true;
  });
  return (
    <>
      <p className="text-muted-foreground text-xs">{t.entitiesIntro}</p>
      {unique.length === 0 && <EmptyState>{t.entitiesEmpty}</EmptyState>}
      <div className="flex flex-col gap-1.5">
        {unique.map((entity) => (
          <EntityRow key={entity.id} entity={entity} facts={[...data.facts, ...data.sharedFacts]} />
        ))}
      </div>
    </>
  );
}

function EntityRow({ entity, facts }: { entity: MemoryV2Entity; facts: MemoryV2Fact[] }) {
  const about = facts.filter(
    (fact) => fact.entities.includes(entity.id) && fact.status === "current",
  );
  const merged = entity.mergedInto;
  return (
    <Dialog>
      <DialogTrigger
        render={
          <RowButton
            aria-label={t.entityAria(entity.name)}
            className="hover:bg-muted flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-sm"
          >
            <span className="bg-secondary text-secondary-foreground flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold">
              {entity.name.slice(0, 1).toLocaleUpperCase("en")}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{entity.name}</span>
              <span className="text-muted-foreground block truncate text-xs">
                {t.ENTITY_TYPES[entity.type] ?? entity.type}
                {entity.aliases.length > 0 && ` · ${entity.aliases.length} aliases`}
                {about.length > 0 && ` · ${about.length} facts`}
              </span>
            </span>
            {merged !== null && (
              <Badge variant="outline" className="shrink-0">
                merged
              </Badge>
            )}
          </RowButton>
        }
      />
      <DialogContent>
        <DialogTitle>{entity.name}</DialogTitle>
        <EntitySheet entity={entity} about={about} />
      </DialogContent>
    </Dialog>
  );
}

function EntitySheet({ entity, about }: { entity: MemoryV2Entity; about: MemoryV2Fact[] }) {
  const target = entity.mergedInto;
  return (
    <div className="mt-2 flex flex-col gap-2.5 text-sm">
      <Badge variant="secondary" className="w-fit">
        {t.ENTITY_TYPES[entity.type] ?? entity.type}
      </Badge>
      {entity.summary !== "" && (
        <div>
          <p className="text-muted-foreground text-xs font-semibold">{t.summaryLabel}</p>
          <p className="mt-0.5 break-words">{entity.summary}</p>
        </div>
      )}
      {entity.aliases.length > 0 && (
        <div>
          <p className="text-muted-foreground text-xs font-semibold">{t.aliasesLabel}</p>
          <div className="mt-1 flex flex-wrap gap-1">
            {entity.aliases.map((alias) => (
              <Badge key={alias} variant="outline" className="w-fit break-words">
                {alias}
              </Badge>
            ))}
          </div>
        </div>
      )}
      {target !== null && <p className="text-muted-foreground text-xs">{t.mergedNote(target)}</p>}
      <div>
        <p className="text-muted-foreground text-xs font-semibold">
          {t.factsAboutLabel} ({about.length})
        </p>
        {about.length === 0 ? (
          <p className="text-muted-foreground mt-1 text-xs">Nothing about this yet.</p>
        ) : (
          <ul className="mt-1 flex flex-col gap-1">
            {about.slice(0, 12).map((fact) => (
              <li key={fact.id} className="border-border/60 border-l pl-2 break-words">
                {fact.text}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
