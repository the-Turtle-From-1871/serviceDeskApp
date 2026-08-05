"use client";

import * as React from "react";
import * as ProgressPrimitive from "@radix-ui/react-progress";

import { cn } from "@/lib/utils";

/**
 * Ledger-stock progress rule: a 2px hairline rather than a chunky pill, so it
 * reads as an underline on the search field instead of a floating widget.
 *
 * INDETERMINATE IS THE POINT HERE. Passing `value={null}` puts Radix into its
 * indeterminate state (`data-state="indeterminate"`, and `aria-valuenow` is
 * omitted so assistive tech announces "busy" rather than a made-up
 * percentage). A search has no knowable completion percentage — a creeping
 * fake bar would be inventing one — so the indeterminate branch animates a
 * sweeping segment and reports no value at all. Pass a number only where real
 * progress exists (a known-length upload, an N-of-M batch).
 *
 * NOTE: Tailwind preflight is deliberately not loaded in this app. Both parts
 * render as `<div>`, which needs nothing preflight supplies, and neither sets
 * a `border-*` width — so the "border width without border-solid" trap that
 * bit `table.tsx` does not apply here. Keep it that way: if you add a border,
 * add `border-solid` (and zero the other three sides for a single-side rule).
 */
function Progress({
  className,
  value,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  const indeterminate = value === null || value === undefined;

  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      value={value}
      className={cn(
        "relative h-0.5 w-full overflow-hidden rounded-ledger-sm bg-border",
        className,
      )}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className={cn(
          "block h-full bg-primary",
          indeterminate
            ? // The sweeping segment. `motion-reduce` swaps the infinite
              // animation for a static dimmed fill: an endlessly moving bar is
              // exactly what prefers-reduced-motion exists to suppress, and a
              // dimmed full-width rule still reads as "working".
              "w-2/5 animate-search-sweep motion-reduce:w-full motion-reduce:animate-none motion-reduce:opacity-50"
            : "w-full transition-transform duration-300 ease-out",
        )}
        style={
          indeterminate
            ? undefined
            : { transform: `translateX(-${100 - (value ?? 0)}%)` }
        }
      />
    </ProgressPrimitive.Root>
  );
}

export { Progress };
