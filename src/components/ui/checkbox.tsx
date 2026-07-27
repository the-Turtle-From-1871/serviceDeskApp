"use client";

import * as React from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check, Minus } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Supports Radix's tri-state `checked={true | false | "indeterminate"}`, which
 * is what a "select all" header checkbox needs. Radix renders the indicator for
 * both `checked` and `indeterminate`, so both glyphs live inside it and the
 * wrong one is hidden by the root's `data-state`. Each icon is hidden by its
 * own explicit state rather than relying on utility ordering to break a tie.
 *
 * Radix sets `aria-checked="mixed"` in the indeterminate state, so the tri-state
 * is conveyed to assistive tech without extra wiring.
 *
 * The root is a `<button>`, and preflight is not loaded, so the UA button
 * background/border/appearance are reset explicitly.
 */
function Checkbox({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer group inline-flex size-4 shrink-0 items-center justify-center",
        "appearance-none rounded-ledger-sm border border-solid border-input bg-card p-0",
        "cursor-pointer transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground",
        "data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="flex items-center justify-center text-current"
      >
        <Check
          aria-hidden="true"
          strokeWidth={3}
          className="block size-3 shrink-0 group-data-[state=indeterminate]:hidden"
        />
        <Minus
          aria-hidden="true"
          strokeWidth={3}
          className="block size-3 shrink-0 group-data-[state=checked]:hidden"
        />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
