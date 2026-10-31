/** Opens the quick switcher and the shortcut sheet from anywhere (the sidebar's Find button). */
import { createContext, useContext } from "react";

export interface QuickSwitchControls {
  openSwitcher: () => void;
  openShortcuts: () => void;
}

export const QuickSwitchContext = createContext<QuickSwitchControls | null>(null);

/** null outside the provider (tests, isolated screens). */
export function useQuickSwitch(): QuickSwitchControls | null {
  return useContext(QuickSwitchContext);
}
