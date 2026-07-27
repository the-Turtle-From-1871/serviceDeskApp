"use client";

import * as React from "react";
import * as ToggleGroupPrimitive from "@radix-ui/react-toggle-group";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * Segmented-control styling: items are joined with overlapping hairlines and
 * only the outer edges are rounded. As elsewhere, the UA `<button>` defaults
 * are reset explicitly because preflight is not loaded.
 */
const toggleGroupItemVariants = cva(
  [
    "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap",
    "appearance-none border border-solid bg-transparent",
    "font-sans text-sm font-medium leading-none text-foreground",
    "cursor-pointer select-none transition-colors",
    "-ml-px first:ml-0 rounded-none first:rounded-l-ledger last:rounded-r-ledger",
    "hover:bg-accent hover:text-accent-foreground",
    "focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
    "data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:border-primary",
    "[&_svg]:pointer-events-none [&_svg]:block [&_svg]:shrink-0",
  ],
  {
    variants: {
      variant: {
        default: "border-transparent",
        outline: "border-border bg-card",
      },
      size: {
        sm: "h-8 px-2 text-xs [&_svg]:size-3.5 pointer-coarse:h-11 max-md:h-11",
        default: "h-9 px-3 [&_svg]:size-4 pointer-coarse:h-11 max-md:h-11",
        lg: "h-11 px-4 text-base [&_svg]:size-4",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

const ToggleGroupContext = React.createContext<
  VariantProps<typeof toggleGroupItemVariants>
>({
  variant: "default",
  size: "default",
});

function ToggleGroup({
  className,
  variant,
  size,
  children,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Root> &
  VariantProps<typeof toggleGroupItemVariants>) {
  return (
    <ToggleGroupPrimitive.Root
      data-slot="toggle-group"
      data-variant={variant}
      data-size={size}
      className={cn("flex w-fit items-center rounded-ledger", className)}
      {...props}
    >
      <ToggleGroupContext.Provider value={{ variant, size }}>
        {children}
      </ToggleGroupContext.Provider>
    </ToggleGroupPrimitive.Root>
  );
}

function ToggleGroupItem({
  className,
  children,
  variant,
  size,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Item> &
  VariantProps<typeof toggleGroupItemVariants>) {
  const context = React.useContext(ToggleGroupContext);

  return (
    <ToggleGroupPrimitive.Item
      data-slot="toggle-group-item"
      data-variant={context.variant ?? variant}
      data-size={context.size ?? size}
      className={cn(
        toggleGroupItemVariants({
          variant: context.variant ?? variant,
          size: context.size ?? size,
        }),
        className,
      )}
      {...props}
    >
      {children}
    </ToggleGroupPrimitive.Item>
  );
}

export { ToggleGroup, ToggleGroupItem, toggleGroupItemVariants };
