/**
 * States as marks: the UI reads state through a small vocabulary of
 * drawn marks, one consistent stroke, never emoji, never glow. A mark is 1em
 * at its row scale and carries its tone through the theme state colors:
 * ink when quiet, live amber when working, signal red when the owner is
 * demanded, ok green when something settled.
 */
import { cn } from "@/lib/utils";

export type MarkTone = "ink" | "live" | "signal" | "ok" | "muted";
export type MarkKind = "pending" | "working" | "done" | "error" | "attention" | "disabled";

export function Mark({
  kind,
  tone = "ink",
  label,
  className,
}: {
  kind: MarkKind;
  tone?: MarkTone;
  /** Announces the state when present; otherwise the mark is decorative. */
  label?: string;
  className?: string;
}) {
  return (
    <svg
      aria-hidden={label === undefined}
      role={label === undefined ? undefined : "img"}
      aria-label={label}
      viewBox="0 0 16 16"
      className={cn("size-3.5 shrink-0", toneClass(tone), className)}
    >
      {shapeOf(kind)}
    </svg>
  );
}

function toneClass(tone: MarkTone): string {
  switch (tone) {
    case "live":
      return "text-live";
    case "signal":
      return "text-signal";
    case "ok":
      return "text-ok";
    case "muted":
      return "text-muted-foreground";
    default:
      return "text-foreground";
  }
}

function shapeOf(kind: MarkKind) {
  switch (kind) {
    case "pending":
      return (
        <circle
          cx="8"
          cy="8"
          r="5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          opacity="0.45"
        />
      );
    case "working":
      return (
        <path
          d="M 8 3 A 5 5 0 1 1 3 8"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          className="origin-center animate-spin"
          style={{ transformOrigin: "8px 8px" }}
        />
      );
    case "done":
      return <circle cx="8" cy="8" r="3" fill="currentColor" />;
    case "error":
      return (
        <g>
          <circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <line
            x1="5.6"
            y1="5.6"
            x2="10.4"
            y2="10.4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </g>
      );
    case "attention":
      return (
        <g>
          <circle cx="8" cy="8" r="3.25" fill="currentColor" />
          <circle
            cx="8"
            cy="8"
            r="3.25"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className="motion-safe:animate-[ping-soft_2.4s_cubic-bezier(0,0,0.2,1)_infinite]"
          />
        </g>
      );
    case "disabled":
      return (
        <g opacity="0.5">
          <circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <line
            x1="5.6"
            y1="10.4"
            x2="10.4"
            y2="5.6"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </g>
      );
  }
}
