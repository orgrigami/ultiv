import * as React from "react";
import { cn } from "cn";

const textareaBase =
  "flex field-sizing-content min-h-16 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40";

/** Borderless and unpadded, for the composer field inside its own chrome. */
const textareaBare =
  "flex field-sizing-content min-h-10 pointer-coarse:min-h-11 w-full rounded-none border-0 bg-transparent px-0 py-2.5 text-base outline-none placeholder:text-muted-foreground focus-visible:ring-0 focus-visible:border-0 disabled:cursor-not-allowed disabled:opacity-50 md:text-base dark:bg-transparent";

/** A fixed editor box: skill and reference file bodies, schemas. */
const textareaEditor =
  "flex field-sizing-fixed h-80 min-h-0 w-full rounded-lg border border-input bg-transparent p-3 text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30 dark:disabled:bg-input/80";

function Textarea({
  className,
  variant = "default",
  size = "default",
  mono = false,
  ...props
}: React.ComponentProps<"textarea"> & {
  variant?: "default" | "bare";
  size?: "default" | "editor";
  mono?: boolean;
}) {
  const look =
    variant === "bare" ? textareaBare : size === "editor" ? textareaEditor : textareaBase;
  return (
    <textarea data-slot="textarea" className={cn(look, mono && "font-mono", className)} {...props} />
  );
}

export { Textarea };
