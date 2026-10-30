/**
 * The frame every system card shares: a quiet rounded surface with an icon,
 * a one-line title, a right-aligned meta line (duration, source, time) and
 * optional body. Fades/slides in once, still under reduced motion.
 */
import { formatClock, formatFull } from "@/lib/format";
import { cn } from "@/lib/utils";

const tones = {
  plain: "bg-muted/30 border-border/60",
  danger: "bg-destructive/5 border-destructive/30",
  muted: "bg-transparent border-border border-dashed",
} as const;

export const enter =
  "animate-in fade-in slide-in-from-bottom-1 duration-200 motion-reduce:animate-none";

export function CardShell({
  icon,
  title,
  meta,
  at,
  tone = "plain",
  children,
}: {
  icon: React.ReactNode;
  title: React.ReactNode;
  meta?: string | undefined;
  at: number;
  tone?: keyof typeof tones;
  children?: React.ReactNode;
}) {
  return (
    <div className={cn("w-full rounded-lg border px-3.5 py-2.5 text-sm", tones[tone], enter)}>
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex shrink-0 [&_svg]:size-4">{icon}</span>
        <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
        <time
          className="text-muted-foreground readout shrink-0"
          dateTime={new Date(at).toISOString()}
          title={formatFull(at)}
        >
          {meta !== undefined && meta !== "" ? `${meta} · ` : ""}
          {formatClock(at)}
        </time>
      </div>
      {children !== undefined && <div className="mt-1.5 min-w-0 pl-6">{children}</div>}
    </div>
  );
}

/** A small text toggle ("Show full result" / "Hide"), 44px tall on touch. */
export function ShowMore({
  open,
  onToggle,
  more,
  less = "Hide",
  controls,
}: {
  open: boolean;
  onToggle: () => void;
  more: string;
  less?: string;
  controls: string;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
      className="text-primary focus-visible:ring-ring/50 -ml-1 cursor-pointer rounded-md px-1 text-xs font-medium outline-none hover:underline focus-visible:ring-3 pointer-coarse:min-h-11"
    >
      {open ? less : more}
    </button>
  );
}
