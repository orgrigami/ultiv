/**
 * A Mermaid diagram drawn in the browser with Pele: a bordered card with the
 * drawing, a copy-source button and a larger view (a bottom sheet on phones).
 * The tool card and chat Markdown's ```mermaid fences both use it. Pele loads
 * on first use; until the drawing lands a quiet placeholder holds the space.
 * A source Pele can't draw never leaves a blank card: Markdown falls back to
 * the plain code block, the tool card says why and shows the source.
 */
import "./diagram.css";
import { useEffect, useId, useState, type ReactNode } from "react";
import { Maximize2Icon, TriangleAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CodeBlockCopyButton } from "@/components/ui/code-block";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { drawDiagram, type Drawn } from "@/lib/diagram";

/** The drawing for `source`. While a changed source (a streaming fence) is
 * redrawn the last drawing stays up; a draw that lands late is dropped. */
function useDrawn(source: string): Drawn | null {
  const prefix = `d${useId().replace(/[^a-zA-Z0-9]/g, "")}-`;
  const [drawn, setDrawn] = useState<Drawn | null>(null);
  useEffect(() => {
    let live = true;
    void drawDiagram(source, prefix).then((result) => {
      if (live) setDrawn(result);
    });
    return () => {
      live = false;
    };
  }, [source, prefix]);
  return drawn;
}

/** The sanitized SVG, inlined so the page's theme variables reach it. */
function Drawing({ svg, className }: { svg: string; className?: string }) {
  // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitizeSvg's allowlist output
  return <div className={`diagram ${className ?? ""}`} dangerouslySetInnerHTML={{ __html: svg }} />;
}

function Larger({ svg, label }: { svg: string; label: string }) {
  return (
    <Dialog>
      <DialogTrigger
        render={
          <Button variant="ghost" size="icon-xs" aria-label="View larger">
            <Maximize2Icon />
          </Button>
        }
      />
      <DialogContent>
        <DialogTitle className="mb-3 pr-8 text-sm font-medium">{label}</DialogTitle>
        <div className="overflow-auto">
          {/* Natural size here: a wide drawing shrunk to fit the chat scrolls instead. */}
          <Drawing svg={svg} className="[&_svg]:!max-w-none" />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Failed({ message, source }: { message: string; source: string }) {
  return (
    <div className="flex flex-col gap-2 px-3 pb-3">
      <p className="text-destructive flex items-start gap-1.5 text-sm" role="status">
        <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 break-words">Couldn't draw this diagram. {message}</span>
      </p>
      <pre className="readout bg-muted/60 max-h-60 overflow-auto rounded-lg p-2.5 text-xs whitespace-pre">
        {source}
      </pre>
    </div>
  );
}

export function Diagram({
  source,
  title,
  fallback,
  className,
}: {
  source: string;
  title?: string | null | undefined;
  /** Shown instead of the error card (Markdown passes its plain code block). */
  fallback?: ReactNode;
  className?: string;
}) {
  const drawn = useDrawn(source);
  if (drawn?.ok === false && fallback !== undefined) return <>{fallback}</>;
  const label = title ?? (drawn?.ok === true ? `${drawn.type} diagram` : "Diagram");
  return (
    <figure className={`not-prose bg-card min-w-0 rounded-2xl border ${className ?? "my-2"}`}>
      <figcaption className="flex min-h-9 items-center gap-2 py-1 pr-1.5 pl-3">
        <span className="readout text-muted-foreground min-w-0 flex-1 truncate text-xs">
          {label}
        </span>
        <CodeBlockCopyButton value={source} aria-label="Copy diagram source" />
        {drawn?.ok === true && <Larger svg={drawn.svg} label={label} />}
      </figcaption>
      {drawn === null && (
        <div className="bg-muted/60 mx-3 mb-3 h-36 rounded-xl motion-safe:animate-pulse" />
      )}
      {drawn?.ok === true && (
        <div className="overflow-x-auto px-3 pb-3">
          <Drawing svg={drawn.svg} />
        </div>
      )}
      {drawn?.ok === false && <Failed message={drawn.message} source={source} />}
    </figure>
  );
}

export default Diagram;
