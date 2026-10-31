import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

/**
 * Phones: a bottom sheet (slides up, rounded top, clear of the home
 * indicator). Desktop: a centred dialog. Both keep a visible ✕; Escape and the
 * backdrop still close it. The sheet itself is the only scroll area.
 */
function DialogContent({
  children,
  showCloseButton = true,
  className,
  ...props
}: DialogPrimitive.Popup.Props & { showCloseButton?: boolean }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/50 transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none" />
      <DialogPrimitive.Popup
        data-slot="dialog-popup"
        className={cn(
          "bg-card text-card-foreground fixed inset-x-0 bottom-0 z-50 max-h-[90dvh] w-full overflow-y-auto overscroll-contain rounded-t-xl border-t p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-lg transition-[translate,opacity] duration-200 ease-out data-ending-style:translate-y-full data-starting-style:translate-y-full motion-reduce:transition-none sm:inset-x-auto sm:top-1/2 sm:bottom-auto sm:left-1/2 sm:max-h-[85dvh] sm:w-[min(48rem,92vw)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl sm:border sm:p-6 sm:data-ending-style:-translate-y-1/2 sm:data-ending-style:opacity-0 sm:data-starting-style:-translate-y-1/2 sm:data-starting-style:opacity-0",
          typeof className === "string" ? className : undefined,
        )}
        {...props}
      >
        <div
          aria-hidden
          className="bg-muted-foreground/30 mx-auto -mt-2 mb-3 h-1 w-10 rounded-full sm:hidden"
        />
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-x"
            render={
              <Button variant="ghost" size="icon-sm" className="absolute top-3 right-3">
                <XIcon />
              </Button>
            }
            aria-label="Close"
          />
        )}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  );
}

function DialogTitle({ ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className="pr-8 text-title font-semibold tracking-tight"
      {...props}
    />
  );
}

export { Dialog, DialogTrigger, DialogContent, DialogTitle, DialogClose };
