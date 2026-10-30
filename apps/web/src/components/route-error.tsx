/**
 * When a screen itself fails, or a path leads nowhere: the station says so
 * plainly, in its own voice, with the ways out. Rendered inside the layout,
 * so the console rail stays and the owner is never lost.
 */
import { useNavigate } from "@tanstack/react-router";
import { Mark } from "@/components/state-mark";
import { Button } from "@/components/ui/button";

function Shell({
  title,
  words,
  detail,
  children,
}: {
  title: string;
  words: string;
  detail: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-6">
      <div className="flex max-w-md flex-col items-start gap-3 text-left">
        <Mark kind="error" tone="signal" className="size-5" />
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        <p className="text-muted-foreground text-sm">{words}</p>
        <p className="readout text-muted-foreground/70 max-w-full break-all rounded-md border px-2 py-1">
          {detail}
        </p>
        <div className="mt-1 flex gap-2">{children}</div>
      </div>
    </div>
  );
}

/** A render error in a route: reload the screen, or go home. */
export function RouteError({ error, reset }: { error: unknown; reset: () => void }) {
  const navigate = useNavigate();
  const detail =
    error instanceof Error && error.message !== ""
      ? error.message
      : String(error ?? "unknown error");
  return (
    <Shell
      title="This screen broke"
      words="The rest of the station is fine. Reloading usually fixes it; if it keeps happening, the error line below is the clue."
      detail={detail}
    >
      <Button variant="outline" size="sm" onClick={() => reset?.()}>
        Reload
      </Button>
      <Button variant="ghost" size="sm" onClick={() => void navigate({ to: "/" })}>
        Back to the chat
      </Button>
    </Shell>
  );
}

/** A path that leads nowhere. */
export function RouteNotFound() {
  const navigate = useNavigate();
  return (
    <Shell
      title="Nothing lives here"
      words="The station has no screen at this address. It may have moved, or the link may be wrong."
      detail="404 · not found"
    >
      <Button variant="outline" size="sm" onClick={() => void navigate({ to: "/" })}>
        Back to the chat
      </Button>
    </Shell>
  );
}
