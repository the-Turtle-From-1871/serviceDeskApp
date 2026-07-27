"use client";

import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * NOTE: Tailwind preflight is deliberately not loaded in this app, so the base
 * classes below re-declare everything the UA stylesheet would otherwise supply
 * for `<button>`: `appearance`, an explicit background + border (UA gives
 * `buttonface` / `2px outset buttonborder`), and the font shorthand (a UA
 * button does NOT inherit the page font). `border-solid` matters too — the
 * `border-*` utilities only set width, and preflight is what normally sets the
 * style. Likewise `svg` is `display: inline` without preflight, which would
 * introduce a descender gap, hence `[&_svg]:block`.
 */
const buttonVariants = cva(
  [
    "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap",
    "appearance-none border border-solid border-transparent",
    "font-sans text-sm font-medium leading-none",
    "rounded-ledger cursor-pointer select-none",
    "transition-colors",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
    "aria-disabled:pointer-events-none aria-disabled:cursor-not-allowed aria-disabled:opacity-50",
    "[&_svg]:pointer-events-none [&_svg]:block [&_svg]:shrink-0",
  ],
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        secondary:
          "bg-secondary text-secondary-foreground border-border hover:bg-muted",
        outline:
          "bg-transparent text-foreground border-border hover:bg-accent hover:text-accent-foreground",
        ghost:
          "bg-transparent text-foreground hover:bg-accent hover:text-accent-foreground",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90",
      },
      size: {
        sm: "h-8 gap-1.5 px-3 text-xs [&_svg]:size-3.5 pointer-coarse:h-11 max-md:h-11",
        default: "h-9 px-4 [&_svg]:size-4 pointer-coarse:h-11 max-md:h-11",
        lg: "h-11 px-6 text-base [&_svg]:size-4",
        icon: "size-9 p-0 [&_svg]:size-4 pointer-coarse:size-11 max-md:size-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

type ButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    /** Render the child element instead of a `<button>`, merging props onto it. */
    asChild?: boolean;
  };

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot : "button";

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
export type { ButtonProps };
