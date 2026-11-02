import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow,opacity,transform] duration-150 outline-none motion-reduce:transition-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:scale-[0.98] motion-reduce:active:not-aria-[haspopup]:scale-100 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/80",
        outline:
          "border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost:
          "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40",
        link: "text-primary underline-offset-4 hover:underline",
        quiet:
          "text-muted-foreground hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50",
        "ghost-destructive":
          "text-destructive hover:bg-destructive/10 hover:text-destructive dark:hover:bg-destructive/20",
        muted: "bg-muted/70 text-foreground hover:bg-muted aria-expanded:bg-muted",
        signal:
          "border-border bg-background text-signal hover:bg-signal/10 aria-expanded:bg-signal/10 dark:border-input dark:bg-input/30 dark:hover:bg-signal/20",
        segment:
          "text-muted-foreground hover:text-foreground aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-xs aria-current:bg-background aria-current:text-foreground aria-current:shadow-xs",
        tab: "text-muted-foreground hover:text-foreground pointer-coarse:min-h-11 aria-pressed:bg-secondary aria-pressed:text-secondary-foreground aria-selected:bg-secondary aria-selected:text-secondary-foreground",
        filter:
          "min-h-11 gap-1.5 px-3.5 py-1 sm:min-h-9 bg-card text-muted-foreground hover:text-foreground aria-selected:bg-foreground aria-selected:text-background aria-selected:border-transparent aria-selected:font-medium",
      },
      // Pill-shaped buttons (the chat chrome pills, chips and round CTAs).
      pill: {
        true: "rounded-full",
      },
      // Touch screens (pointer: coarse) get 44px minimum targets; mouse sizes are unchanged.
      size: {
        default:
          "h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 pointer-coarse:min-h-11",
        fit: "h-auto min-h-11 gap-1.5 px-2.5 py-1.5 pointer-coarse:min-h-11",
        xl: "h-11 gap-1.5 px-2.5 pointer-coarse:min-h-11",
        inline: "h-auto gap-1 p-0 text-xs",
        xs: "h-6 gap-1 rounded-md px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3 pointer-coarse:min-h-11",
        sm: "h-7 gap-1 rounded-md px-2.5 text-sm in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5 pointer-coarse:min-h-11",
        lg: "h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 pointer-coarse:min-h-11",
        icon: "size-8 pointer-coarse:min-h-11 pointer-coarse:min-w-11",
        "icon-xs":
          "size-6 rounded-md in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3 pointer-coarse:min-h-11 pointer-coarse:min-w-11",
        "icon-sm":
          "size-7 rounded-md in-data-[slot=button-group]:rounded-lg pointer-coarse:min-h-11 pointer-coarse:min-w-11",
        "icon-lg": "size-9 pointer-coarse:min-h-11 pointer-coarse:min-w-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
