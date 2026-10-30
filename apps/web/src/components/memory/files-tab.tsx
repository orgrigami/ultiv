/**
 * Files tab: the artifacts the bot made (downloads) and the "already handled"
 * key-value state it uses to not redo work.
 */
import { Trash2Icon } from "lucide-react";
import { FileCard } from "@/components/file-card";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { SectionHeader } from "@/components/ui/section-header";
import { DevDetails } from "@/components/ui/dev-details";
import type { MemoryData } from "@/components/memory/memory-panel";
import { api } from "@/lib/api";
import { formatWhen } from "@/lib/format";
import * as t from "@/lib/memory-text";

interface TabProps {
  data: MemoryData;
  profileId: string;
  name: string;
  reload: () => Promise<void>;
}

export function FilesTab({ data, profileId, name, reload }: TabProps) {
  return (
    <>
      <SectionHeader title={`Files ${name} made`} />
      <div className="flex flex-col gap-2">
        {data.artifacts.length === 0 ? (
          <EmptyState>{t.filesEmpty}</EmptyState>
        ) : (
          data.artifacts.map((artifact) => <FileCard key={artifact.id} file={artifact} />)
        )}
      </div>
      <SectionHeader title="Already handled" className="mt-2" />
      <div className="flex flex-col gap-2">
        {data.kv.length === 0 ? (
          <EmptyState>{t.kvEmpty(name)}</EmptyState>
        ) : (
          data.kv.map((row) => (
            <div
              key={row.key}
              className="flex items-start gap-2 rounded-lg border px-2.5 py-1.5 text-sm"
            >
              <div className="min-w-0 flex-1">
                <code className="text-xs">{row.key}</code>
                <p className="text-muted-foreground truncate text-xs" title={row.value}>
                  {row.value}
                </p>
                <p className="text-muted-foreground text-xs">{formatWhen(row.updatedAt)}</p>
              </div>
              <ConfirmDialog
                title={`Delete ${row.key}?`}
                warning={t.kvDeleteWarning(name)}
                onConfirm={async () => {
                  await api.removeState(profileId, row.key);
                  await reload();
                }}
              >
                <Button variant="ghost" size="icon" aria-label={`Delete ${row.key}`}>
                  <Trash2Icon />
                </Button>
              </ConfirmDialog>
            </div>
          ))
        )}
      </div>
      <DevDetails className="mt-2">
        Key-value state the bot reads and writes with state_get and state_set.
      </DevDetails>
    </>
  );
}
