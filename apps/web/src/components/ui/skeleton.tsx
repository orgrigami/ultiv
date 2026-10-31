/** Placeholder rows in the shape of what is loading; the sheen stops under reduced motion. */
import { cn } from "@/lib/utils";

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("skeleton rounded-xl", className)} />;
}

/** A labelled stack of placeholder rows: the list that is on its way. */
export function SkeletonRows({
  label,
  rows = 3,
  rowClassName,
  className,
}: {
  /** Read out instead of the rows, e.g. "Loading routines". */
  label: string;
  rows?: number;
  rowClassName?: string;
  className?: string;
}) {
  return (
    <div role="status" aria-label={label} className={cn("flex flex-col gap-2", className)}>
      {Array.from({ length: rows }, (_, row) => (
        <Skeleton key={row} className={cn("h-12 rounded-2xl", rowClassName)} />
      ))}
    </div>
  );
}
