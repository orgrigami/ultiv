import * as React from "react";

import { cn } from "cn";

const headingSize = {
  title: "text-title",
  base: "text-base",
  ui: "text-ui",
  sm: "text-sm",
  xs: "text-xs",
} as const;

type HeadingProps = React.ComponentProps<"h2"> & {
  level?: 1 | 2 | 3 | 4 | 5 | 6;
  size?: keyof typeof headingSize;
};

/** The one heading style: pick a size from the scale, don't write one. */
export function Heading({ level = 2, size = "sm", className, ...props }: HeadingProps) {
  const Tag = `h${level}` as "h2";
  return <Tag data-slot="heading" className={cn("font-semibold", headingSize[size], className)} {...props} />;
}
