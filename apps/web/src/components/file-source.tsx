/**
 * "From <chat>": where a file came from, as a link to that chat (a main chat
 * opens as its bot's Chat tab). A file a background task wrote names the task
 * and links the chat that spawned it. The server resolves the source
 * (`source` on /api/artifacts?sources=1 rows and on every /meta).
 */
import { Link } from "@tanstack/react-router";
import { MessageCircleIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { ArtifactSource } from "@spriessen/contracts";
import { api } from "@/lib/api";
import { useApp } from "@/lib/app-state";
import { cn } from "@/lib/utils";

/** The words of the link: the chat, and the task when one wrote it. */
export const sourceText = (source: ArtifactSource): string =>
  source.task !== undefined
    ? `From task "${source.task.title}" in ${source.title}`
    : `From ${source.title}`;

export function FileSource({
  source,
  className,
}: {
  source: ArtifactSource | null | undefined;
  className?: string;
}) {
  const { mainId } = useApp();
  if (source === null || source === undefined) return null;
  const style = cn(
    "text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex min-h-8 max-w-full items-center gap-1.5 rounded-md text-xs outline-none focus-visible:ring-3",
    className,
  );
  const body = (
    <>
      <MessageCircleIcon className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">{sourceText(source)}</span>
    </>
  );
  return source.main ? (
    <Link to="/" search={source.botId === mainId ? {} : { bot: source.botId }} className={style}>
      {body}
    </Link>
  ) : (
    <Link to="/c/$sessionId" params={{ sessionId: source.sessionId }} className={style}>
      {body}
    </Link>
  );
}

/** The source of one file by id (one /meta read), for views that only hold a ref. */
export function FileSourceById({ id, className }: { id: string; className?: string }) {
  const [source, setSource] = useState<ArtifactSource | null>(null);
  useEffect(() => {
    let live = true;
    setSource(null);
    api.artifactMeta(id).then(
      (row) => live && setSource(row.source ?? null),
      () => undefined, // A missing file shows no source; the preview says why.
    );
    return () => {
      live = false;
    };
  }, [id]);
  return <FileSource source={source} {...(className !== undefined ? { className } : {})} />;
}
