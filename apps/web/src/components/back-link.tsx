/**
 * The one way back to a parent screen: a quiet labelled row with a left
 * chevron ("Crew", "All conversations"). Tall enough to tap on phones,
 * compact with a mouse; the caller owns the navigation, so the route stays
 * typed at the call site.
 */
import { ChevronLeftIcon } from "lucide-react";
import { RowButton } from "@/components/ui/row-button";
import { cn } from "@/lib/utils";

export function BackLink({
  label,
  onClick,
  className,
}: {
  label: string;
  onClick: () => void;
  className?: string;
}) {
  return (
    <RowButton
      onClick={onClick}
      className={cn(
        "text-muted-foreground hover:text-foreground press -ml-1 inline-flex min-h-11 items-center gap-1 self-start rounded-lg pr-2 text-sm sm:min-h-8",
        className,
      )}
    >
      <ChevronLeftIcon className="size-4" aria-hidden />
      {label}
    </RowButton>
  );
}
