import * as React from "react";

import { cn } from "cn";

/**
 * One tappable row, tile or pill that is not a command button. The shared
 * focus ring, cursor and text alignment live here; layout and look stay with
 * the caller, so every list row, group header, accordion strip and floating
 * pill keeps its own shape under one keyboard-focus pattern.
 */
export function RowButton({ className, type = "button", ...props }: React.ComponentProps<"button">) {
  return (
    <button
      type={type}
      data-slot="row-button"
      className={cn(
        "cursor-pointer text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
        className,
      )}
      {...props}
    />
  );
}
