import { cn } from "@/lib/utils";

/**
 * One tappable list row (≥44px): optional leading icon, a title that
 * truncates (with an optional muted second line, full text on hover), muted
 * meta on the right, and an optional trailing action that
 * sits outside the tap area.
 */
export function ListRow({
  leading,
  title,
  subtitle,
  meta,
  trailing,
  onClick,
  className,
}: {
  leading?: React.ReactNode;
  title: React.ReactNode;
  subtitle?: string | undefined;
  meta?: React.ReactNode;
  trailing?: React.ReactNode;
  onClick: () => void;
  className?: string | undefined;
}) {
  return (
    <div className={cn("flex items-center gap-1", className)}>
      <button
        type="button"
        onClick={onClick}
        className="hover:bg-muted focus-visible:ring-ring/50 flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm outline-none focus-visible:ring-3 [&_svg]:size-4 [&_svg]:shrink-0"
      >
        {leading}
        {subtitle === undefined ? (
          <span className="min-w-0 flex-1 truncate">{title}</span>
        ) : (
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate">{title}</span>
            <span className="text-muted-foreground truncate text-xs" title={subtitle}>
              {subtitle}
            </span>
          </span>
        )}
        {meta !== undefined && (
          <span className="text-muted-foreground shrink-0 text-xs">{meta}</span>
        )}
      </button>
      {trailing}
    </div>
  );
}
