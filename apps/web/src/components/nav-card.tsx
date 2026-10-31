/** A file-style card: a tinted icon tile, a title, one line, and a chevron. */
import { Link, type LinkProps } from "@tanstack/react-router";
import { ChevronRightIcon, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export function NavCard({
  icon: Icon,
  title,
  detail,
  className,
  ...link
}: LinkProps & {
  icon: LucideIcon;
  title: string;
  detail: string;
  className?: string;
}) {
  return (
    <Link
      {...link}
      className={cn(
        "press bg-card hover:bg-muted/50 focus-visible:ring-ring/50 group flex min-h-16 items-center gap-3 rounded-2xl border px-3 py-3 outline-none focus-visible:ring-3",
        className,
      )}
    >
      <span className="bg-muted text-foreground grid size-10 shrink-0 place-items-center rounded-xl">
        <Icon className="size-5" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-muted-foreground truncate text-xs">{detail}</span>
      </span>
      <ChevronRightIcon className="text-muted-foreground size-4 shrink-0 transition-transform duration-150 group-hover:translate-x-0.5 motion-reduce:transition-none" />
    </Link>
  );
}
