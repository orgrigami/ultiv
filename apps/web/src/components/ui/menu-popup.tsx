import { Menu } from "@base-ui/react/menu";
import * as React from "react";

import { cn } from "cn";

/** The one menu popup look: popover surface, hairline border, soft shadow, safe focus. */
export function MenuPopup({ className, ...props }: React.ComponentProps<typeof Menu.Popup>) {
  return (
    <Menu.Popup
      data-slot="menu-popup"
      className={cn(
        "bg-popover text-popover-foreground rounded-xl border p-1 shadow-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
        className,
      )}
      {...props}
    />
  );
}
