import * as React from "react";

import { Link, type LinkProps } from "@tanstack/react-router";
import { cn } from "cn";

/**
 * The link twin of RowButton: one tappable row-style link. The shared focus
 * ring and cursor semantics live here; layout and look stay with the caller.
 */
export function RowLink({ className, ...props }: LinkProps & React.RefAttributes<HTMLAnchorElement>) {
  return (
    <Link
      data-slot="row-link"
      className={cn(
        "cursor-pointer outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
        className,
      )}
      {...props}
    />
  );
}
