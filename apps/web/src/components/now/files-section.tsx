/**
 * The Now page's newest files across every bot, each with the chat it came
 * from. Loads on the page (one read, `?limit=&sources=1`) and again when
 * tasks or chats change, since a file lands with one or the other.
 */
import { FileCard } from "@/components/file-card";
import { FileSource } from "@/components/file-source";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { SectionHeader } from "@/components/ui/section-header";
import { SkeletonRows } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { useApp } from "@/lib/app-state";
import { NOW_LIMIT } from "@/lib/now";
import { formatWhen } from "@/lib/format";
import { useLiveLoad } from "@/lib/use-live-load";

export function FilesSection() {
  const { sessions } = useApp();
  const files = useLiveLoad(
    "now-files",
    () => api.recentArtifacts(NOW_LIMIT),
    ["tasks", "sessions"],
    "New files may be out of date",
  );
  const nameOf = (profile: string | null): string =>
    sessions.profiles.find((row) => row.id === profile)?.name ?? "";
  return (
    <section aria-label="New files" className="flex flex-col gap-2">
      <SectionHeader title="New files" />
      {files.failed ? (
        <ErrorState message="Couldn't load the newest files." onRetry={files.retry} />
      ) : files.value === null ? (
        <SkeletonRows label="Loading files" rows={2} />
      ) : files.value.length === 0 ? (
        <EmptyState>No files yet. What your bots make lands here.</EmptyState>
      ) : (
        <ul className="flex flex-col gap-2">
          {files.value.map((file) => (
            <li key={file.id} className="flex flex-col">
              <FileCard file={file} />
              <span className="text-muted-foreground ml-2 flex min-w-0 items-center gap-1.5 text-xs">
                <span className="shrink-0">
                  {[nameOf(file.profile), formatWhen(file.createdAt)]
                    .filter((part) => part !== "")
                    .join(" · ")}
                </span>
                <FileSource source={file.source} className="min-w-0" />
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
