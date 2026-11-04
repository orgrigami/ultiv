import { Menu } from "@base-ui/react/menu";
import * as React from "react";

import { cn } from "cn";
import { sheetPopup } from "@/components/ui/menu-sheet";

/** The one menu popup look: popover surface, hairline border, soft shadow, safe focus.
 *  Inside a `sheetPositioner` it docks as a bottom sheet on phones. */
export function MenuPopup({ className, ...props }: React.ComponentProps<typeof Menu.Popup>) {
  return <Menu.Popup data-slot="menu-popup" className={cn(sheetPopup, className)} {...props} />;
}
