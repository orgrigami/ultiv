import * as React from "react";

import { cn } from "cn";

/** A bordered card surface whose children are divided rows. */
export function ListCard({
  className,
  as = "div",
  ...props
}: React.ComponentProps<"div"> & { as?: "div" | "ul" | "ol" }) {
  const Tag = as;
  return (
    <Tag
      data-slot="list-card"
      className={cn("bg-card flex flex-col divide-y divide-border rounded-xl border", className)}
      {...props}
    />
  );
}
