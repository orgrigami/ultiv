/**
 * One shape for every menu and small popover: anchored beside its trigger
 * on wider screens, a bottom sheet on phones (under 640px) — full width,
 * a grab handle, a dimmed page behind, rows tall enough for a thumb, clear
 * of the home indicator. The sheet is CSS only (`.menu-sheet` in
 * index.css), so Base UI keeps focus, Escape, outside taps and the menu
 * keyboard model; the phone simply sees it docked at the bottom.
 */
import { Menu } from "@base-ui/react/menu";
import { Popover } from "@base-ui/react/popover";
import { cn } from "@/lib/utils";
import { useMedia } from "@/lib/use-media";

/** Phones: menus become bottom sheets below this width. */
export const PHONE = "(max-width: 639px)";

/** Positioner props shared by every menu: the sheet class + edge padding. */
export const sheetPositioner = {
  className: "menu-sheet z-50",
  collisionPadding: 12,
} as const;

/** The popup surface: popover tones, hairline, soft shadow, safe focus. */
export const sheetPopup =
  "bg-popover text-popover-foreground flex max-w-[calc(100vw-1.5rem)] flex-col rounded-xl border p-1 shadow-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

/** One menu row: 36px with a mouse, 44px on touch, 48px in the phone sheet. */
export const sheetRow =
  "data-highlighted:bg-muted hover:bg-muted focus-visible:bg-muted flex min-h-9 w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-left text-sm outline-none select-none data-disabled:cursor-not-allowed data-disabled:opacity-60 pointer-coarse:min-h-11 max-sm:min-h-12 max-sm:text-base [&_svg:not([class*='size-'])]:size-4 max-sm:[&_svg:not([class*='size-'])]:size-5";

/** A row with a second line under its label (a hint or a reason). */
export const sheetRowStacked = cn(
  sheetRow,
  "flex-col items-start justify-center gap-0.5 whitespace-normal",
);

/** The muted second line of a stacked row. */
export const sheetHint = "text-muted-foreground text-xs font-normal max-sm:text-sm";

/** A thin rule between groups. */
export function SheetSeparator() {
  return <div role="separator" className="bg-border mx-1 my-1 h-px max-sm:my-2" />;
}

/** The sheet's heading: phones only by default (the trigger says it on wider
 *  screens). Forwards props, so a Popover.Title can render through it. */
export function SheetHeading({
  children,
  always = false,
  className,
  ...props
}: React.ComponentProps<"p"> & {
  /** Show it on every width (a label the desktop menu needs too). */
  always?: boolean;
}) {
  return (
    <p
      {...props}
      className={cn(
        "text-muted-foreground px-3 pt-2 pb-1 text-xs max-sm:pt-0 max-sm:pb-2 max-sm:text-sm max-sm:font-medium",
        !always && "hidden max-sm:block",
        className,
      )}
    >
      {children}
    </p>
  );
}

const BACKDROP =
  "fixed inset-0 z-50 bg-black/50 transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none sm:hidden";

/** The dimmed page behind a phone sheet (nothing on wider screens). */
export function PopoverSheetBackdrop() {
  return <Popover.Backdrop className={BACKDROP} />;
}

export function MenuSheetBackdrop() {
  return <Menu.Backdrop className={BACKDROP} />;
}

/** Whether menus render as sheets right now (popovers go modal then). */
export function usePhoneSheet(): boolean {
  return useMedia(PHONE);
}
