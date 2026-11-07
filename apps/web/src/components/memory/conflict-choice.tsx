/**
 * A conflict, decided by the owner: both claims side by side with how the
 * bot knows each (said by you, seen, guessed, from outside content), since
 * when, and the chat it was learned in. Recency is shown, never decided on:
 * the owner keeps the one that holds.
 */
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { MemoryV2Chat, MemoryV2Fact } from "@/lib/api";
import { evidenceOf } from "@/lib/memory-evidence";
import * as t from "@/lib/memory-text";

export function ConflictChoice({
  older,
  newer,
  chats,
  busy,
  keeping,
  onKeep,
}: {
  older: MemoryV2Fact;
  newer: MemoryV2Fact;
  chats: Record<string, MemoryV2Chat> | undefined;
  busy: boolean;
  /** The fact being kept while the request runs. */
  keeping: string | null;
  onKeep: (factId: string) => void;
}) {
  const sides = [
    { fact: older, tag: t.olderTag },
    { fact: newer, tag: t.newerTag },
  ];
  return (
    <div className="mt-1.5 flex flex-col gap-2">
      <p className="text-muted-foreground text-xs">{t.conflictNote}</p>
      {sides.map(({ fact, tag }) => (
        <div key={fact.id} className="flex items-start gap-2 rounded-lg border px-2.5 py-2">
          <div className="min-w-0 flex-1">
            <Badge variant="outline" className="w-fit">
              {tag}
            </Badge>
            <p className="mt-1 break-words">{fact.text}</p>
            <p className="text-muted-foreground mt-1 text-xs">
              {evidenceOf(fact, chats).join(" · ")}
            </p>
          </div>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => onKeep(fact.id)}>
            {keeping === fact.id ? t.keepingLabel : t.keepThisLabel}
          </Button>
        </div>
      ))}
    </div>
  );
}
