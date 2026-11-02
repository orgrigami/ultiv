import * as React from "react";
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";

import { cn } from "cn";

const tileTone = {
  card: "bg-card",
  surface: "bg-background",
  danger: "bg-destructive/5",
  accent: "bg-card border-ring/50",
} as const;

const tileRadius = {
  lg: "rounded-lg",
  xl: "rounded-xl",
  "2xl": "rounded-2xl",
  "3xl": "rounded-3xl",
} as const;

type TileProps = useRender.ComponentProps<"div"> & {
  tone?: keyof typeof tileTone;
  radius?: keyof typeof tileRadius;
};

/** The one box surface: a tone, a radius, a hairline. Layout stays with the caller. */
export function Tile({ tone = "card", radius = "xl", render, className, ...props }: TileProps) {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(
      { className: cn("border", tileTone[tone], tileRadius[radius], className) },
      props,
    ),
    render,
  });
}
