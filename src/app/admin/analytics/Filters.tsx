"use client";

import { useCallback, useTransition } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { RANGES, type RangeKey } from "./analytics.types";

/** Sentinel for "All Units". Radix Select forbids an empty-string item value,
 *  and the URL drops the param entirely for the default, so the two states
 *  need distinct representations. */
const ALL = "__all__";

/**
 * All dashboard state lives in the URL, so every widget re-queries on the
 * server when a filter changes — no client-side refetch, no duplicated
 * filtering logic, and the view is shareable/bookmarkable.
 */
export function useSetParam() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  const setParam = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(searchParams.toString());
      if (value === null) next.delete(key);
      else next.set(key, value);
      const qs = next.toString();
      startTransition(() => {
        router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
      });
    },
    [router, pathname, searchParams],
  );

  return { setParam, pending };
}

export function UnitFilter({ units, value }: { units: string[]; value: string | null }) {
  const { setParam, pending } = useSetParam();

  return (
    <Select
      value={value ?? ALL}
      onValueChange={(v) => setParam("uic", v === ALL ? null : v)}
      disabled={pending}
    >
      <SelectTrigger className="w-[220px]" aria-label="Filter by unit (UIC)">
        <SelectValue placeholder="All Units" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>All Units</SelectItem>
        {units.map((u) => (
          <SelectItem key={u} value={u}>
            {u}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function RangeToggle({ value }: { value: RangeKey }) {
  const { setParam, pending } = useSetParam();

  return (
    <ToggleGroup
      type="single"
      value={value}
      // Radix emits "" when the active item is re-clicked; ignore that so the
      // chart can never end up with no range selected.
      onValueChange={(v) => v && setParam("range", v)}
      disabled={pending}
      aria-label="Time range"
    >
      {(Object.keys(RANGES) as RangeKey[]).map((k) => (
        <ToggleGroupItem key={k} value={k} aria-label={RANGES[k].label}>
          {k}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
