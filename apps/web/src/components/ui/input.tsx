import * as React from "react";
import { Input as InputPrimitive } from "@base-ui/react/input";
import { cn } from "cn";

const inputBase =
  "h-8 w-full min-w-0 rounded-lg pointer-coarse:min-h-11 border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40";

/** Borderless and unpadded, for fields that live inside a styled bar. */
const inputBare =
  "h-auto w-full min-w-0 border-0 rounded-none bg-transparent px-0 py-0 text-base outline-none placeholder:text-muted-foreground focus-visible:ring-0 focus-visible:border-0 disabled:cursor-not-allowed disabled:opacity-50 md:text-base dark:bg-transparent";

function Input({
  className,
  type,
  variant = "default",
  mono = false,
  ...props
}: React.ComponentProps<"input"> & { variant?: "default" | "bare"; mono?: boolean }) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(variant === "bare" ? inputBare : inputBase, mono && "font-mono", className)}
      {...props}
    />
  );
}

export { Input };
