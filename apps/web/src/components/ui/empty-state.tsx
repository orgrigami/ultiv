import { Mark } from "@/components/state-mark";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** "Nothing here yet" with an optional hint of how something gets here. */
export function EmptyState({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <p className={cn("text-muted-foreground text-sm", className)}>{children}</p>;
}

/** A load that failed: say so plainly and offer a retry (never an empty list). */
export function ErrorState({
  message,
  onRetry,
  className,
}: {
  message: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <p
      role="alert"
      className={cn(
        "border-signal/25 bg-signal/5 text-signal flex items-center gap-2 rounded-lg border px-2.5 py-2 text-sm",
        className,
      )}
    >
      <Mark kind="error" tone="signal" className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">{message}</span>
      {onRetry !== undefined && (
        <Button variant="outline" size="xs" onClick={onRetry}>
          Retry
        </Button>
      )}
    </p>
  );
}
