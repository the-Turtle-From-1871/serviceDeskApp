"use client";

import { useCallback, useTransition } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  GROUP_BY,
  DEFAULT_GROUP_BY,
  RANGES,
  type GroupByKey,
  type RangeKey,
} from "./analytics.types";

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

/**
 * Chooses the dimension the unit-allocation table groups by.
 *
 * Lives in the URL like every other dashboard control, so the SERVER re-queries
 * with a different `GROUP BY` — this is not a client-side relabel of the rows
 * already fetched. A UIC and a unit name do not describe the same partition of
 * the fleet (see GROUP_BY), so the data genuinely differs between the two.
 */
export function GroupByFilter({ value }: { value: GroupByKey }) {
  const { setParam, pending } = useSetParam();

  return (
    <Select
      value={value}
      // The default drops the param entirely rather than writing `?groupBy=unit`,
      // so a shared link carries only the state that differs from the default.
      onValueChange={(v) => setParam("groupBy", v === DEFAULT_GROUP_BY ? null : v)}
      disabled={pending}
    >
      <SelectTrigger className="w-[150px]" aria-label="Group unit allocation by">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {(Object.keys(GROUP_BY) as GroupByKey[]).map((k) => (
          <SelectItem key={k} value={k}>
            {GROUP_BY[k].label}
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
