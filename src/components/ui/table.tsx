import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Without preflight the UA defaults still apply, so these set explicitly what
 * preflight would normally normalize: `border-collapse` (UA default is
 * `separate` with 2px spacing) and `th`'s alignment/weight (UA default is
 * bold + centered). Border widths also need `border-solid`, since the
 * `border-*` utilities only set width.
 *
 * ⚠️ THE COROLLARY, which is easy to get wrong: `border-solid` sets the style on
 * ALL FOUR sides, but a single-side width utility (`border-b`, `border-t`) sets
 * ONE. With no preflight, the other three sides keep the CSS initial width —
 * `medium`, i.e. **3px** — and a style of `solid` makes them paint. Pairing
 * `border-b border-solid` therefore draws a 3px box, not a 1px underline. So
 * every rule below zeroes the sides it does not want explicitly
 * (`border-x-0 border-t-0 border-b`). Elsewhere in `components/ui` the pairing
 * is the all-sides `border` + `border-solid`, which is why only tables hit this.
 */
function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div
      data-slot="table-container"
      className="relative w-full overflow-x-auto"
    >
      <table
        data-slot="table"
        className={cn(
          "w-full caption-bottom border-collapse text-sm",
          className,
        )}
        {...props}
      />
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      // No border rules here on purpose. Upstream shadcn carries
      // `[&_tr]:border-b`, but a `[&_tr]:` variant compiles to a descendant
      // selector — specificity (0,1,1) — which outranks TableRow's own (0,1,0)
      // utilities in the same layer. It would silently beat a `border-b-0`
      // passed to a TableRow, and it duplicates what TableRow already applies to
      // every header row (all three call sites wrap one). A bare <tr> keeps the
      // initial `border-style: none`, so dropping these paints nothing rather
      // than a wrong-coloured `currentColor` rule.
      className={cn(className)}
      {...props}
    />
  );
}

/**
 * Deliberately NOT stock shadcn: upstream strips the last row's bottom border
 * (`[&_tr:last-child]:border-0`), which assumes the table's container draws the
 * closing line — the way `globals.css` does it, where `.table` sits inside a
 * bordered `.table-wrap`. These tables sit in a plain scroll div inside a Card,
 * so with that rule the final row simply lost its rule and the table trailed off
 * unterminated. Every body row keeps its divider; don't "restore" upstream here
 * without also giving the container a border.
 */
function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return <tbody data-slot="table-body" className={cn(className)} {...props} />;
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn(
        // Keeps the last footer row's border for the same reason as TableBody.
        "border-x-0 border-b-0 border-t border-solid border-border",
        "bg-surface-2 font-medium",
        className,
      )}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-x-0 border-t-0 border-b border-solid border-border transition-colors",
        "hover:bg-surface-2 data-[state=selected]:bg-accent",
        className,
      )}
      {...props}
    />
  );
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "h-10 px-3 text-left align-middle text-xs font-medium tracking-wide text-muted-foreground",
        "whitespace-nowrap [&:has([role=checkbox])]:w-px [&:has([role=checkbox])]:pr-0",
        className,
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "px-3 py-2 align-middle [&:has([role=checkbox])]:w-px [&:has([role=checkbox])]:pr-0",
        className,
      )}
      {...props}
    />
  );
}

function TableCaption({
  className,
  ...props
}: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-4 text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
};
