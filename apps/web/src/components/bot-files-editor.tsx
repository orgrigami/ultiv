/**
 * Persona and Instructions on the profile page (docs/BOT-FILES.md): one
 * plain-text editor per file, its version list newest first, and Restore
 * on any older version (a restore is a new version; history is kept).
 */
import { useCallback, useEffect, useState } from "react";
import { HistoryIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/empty-state";
import { SectionHeader } from "@/components/ui/section-header";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import {
  BOT_FILE_META,
  saveProblem,
  versionLine,
  type BotFileName,
  type BotFileState,
  type BotFileVersion,
} from "@/lib/bot-files";

function FileEditor({
  botId,
  file,
  initial,
  onSaved,
}: {
  botId: string;
  file: BotFileName;
  initial: BotFileState;
  onSaved: () => void;
}) {
  const meta = BOT_FILE_META[file];
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState(initial.text);
  const [versions, setVersions] = useState<BotFileVersion[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = saveProblem(file, draft, saved.text);
  const loadVersions = useCallback(async () => {
    try {
      setVersions(await api.botFileVersions(botId, file));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [botId, file]);
  const settle = async (run: () => Promise<BotFileState>): Promise<void> => {
    setBusy(true);
    try {
      const next = await run();
      setSaved(next);
      setDraft(next.text);
      setError(null);
      if (versions !== null) await loadVersions();
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const id = `bot-file-${file}`;
  return (
    <section className="flex flex-col gap-2" aria-labelledby={`${id}-label`}>
      <div className="flex items-baseline justify-between gap-2">
        <label id={`${id}-label`} htmlFor={id} className="text-sm font-medium">
          {meta.label}
        </label>
        <span className="text-muted-foreground text-xs tabular-nums">v{saved.version}</span>
      </div>
      <p className="text-muted-foreground text-xs">{meta.help}</p>
      <Textarea
        id={id}
        value={draft}
        rows={file === "persona" ? 5 : 8}
        placeholder={meta.empty}
        aria-invalid={problem !== null && problem !== "" ? true : undefined}
        onChange={(event) => setDraft(event.target.value)}
      />
      {problem !== null && problem !== "" && (
        <span role="alert" className="text-destructive text-xs">
          {problem}
        </span>
      )}
      {error !== null && <ErrorState message={error} />}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={busy || problem !== null}
          onClick={() => void settle(() => api.botFileSave(botId, file, draft))}
        >
          Save {meta.label.toLocaleLowerCase("en")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          aria-expanded={versions !== null}
          onClick={() => (versions === null ? void loadVersions() : setVersions(null))}
        >
          <HistoryIcon aria-hidden />
          {versions === null ? "Versions" : "Hide versions"}
        </Button>
      </div>
      {versions !== null && (
        <ol
          className="bg-card divide-border divide-y rounded-2xl border"
          aria-label={`${meta.label} versions`}
        >
          {versions.map((version) => (
            <li key={version.n} className="flex flex-col gap-1 px-3 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground text-xs">{versionLine(version)}</span>
                {version.n === saved.version ? (
                  <span className="text-xs">Current</span>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void settle(() => api.botFileRestore(botId, file, version.n))}
                  >
                    Restore
                  </Button>
                )}
              </div>
              <p className="line-clamp-3 text-sm whitespace-pre-wrap">
                {version.text !== "" ? version.text : meta.empty}
              </p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** Both files for one bot; `onSaved` lets the page refresh the Persona field copy. */
export function BotFilesEditor({ botId, onSaved }: { botId: string; onSaved: () => void }) {
  const [files, setFiles] = useState<Record<BotFileName, BotFileState> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    api
      .botFiles(botId)
      .then((next) => alive && (setFiles(next), setError(null)))
      .catch((cause) => alive && setError(cause instanceof Error ? cause.message : String(cause)));
    return () => {
      alive = false;
    };
  }, [botId, attempt]);
  if (error !== null)
    return (
      <ErrorState
        message={`Couldn't load the files: ${error}`}
        onRetry={() => setAttempt((n) => n + 1)}
      />
    );
  if (files === null) return <SkeletonRows label="Loading persona and instructions" />;
  return (
    <div className="flex flex-col gap-6">
      <SectionHeader title="Persona and instructions" />
      <FileEditor
        key={`${botId}-p`}
        botId={botId}
        file="persona"
        initial={files.persona}
        onSaved={onSaved}
      />
      <FileEditor
        key={`${botId}-i`}
        botId={botId}
        file="instructions"
        initial={files.instructions}
        onSaved={onSaved}
      />
    </div>
  );
}
