/* ============================================================
   Shared analytics vocabulary — constants, labels, and row shapes.

   Deliberately FREE of `server-only` and of any Prisma runtime import, so
   the client widgets can import these values (status keys, labels, range
   definitions) without dragging the query layer — and the database client —
   into the browser bundle. analytics.service.ts re-exports everything here,
   so server code has a single import site.

   Only the `DeployableStatus` *type* is imported from the Prisma client;
   type-only imports are erased at compile time and ship nothing.
   ============================================================ */

import type { DeployableStatus } from "@prisma/client";

/** The four readiness states. */
export const DEPLOYABLE_STATUSES = ["DEPLOYED", "READY_TO_DEPLOY", "IN_REPAIR", "RETIRED"] as const;

/** Items whose deployableStatus is NULL have never been triaged. They are
 *  surfaced as their own series rather than dropped: hiding them would make
 *  the chart's total silently disagree with the fleet size. */
export const UNTRIAGED = "UNTRIAGED" as const;

export type StatusKey = (typeof DEPLOYABLE_STATUSES)[number] | typeof UNTRIAGED;

export const STATUS_LABEL: Record<StatusKey, string> = {
  DEPLOYED: "Deployed",
  READY_TO_DEPLOY: "Ready to deploy",
  IN_REPAIR: "In repair",
  RETIRED: "Retired",
  UNTRIAGED: "Untriaged",
};

export const statusKey = (s: DeployableStatus | null): StatusKey => s ?? UNTRIAGED;

/* ---------- Aliases used by the /items table ----------
   Same vocabulary, named for that surface. Defined here rather than duplicated
   in items-view.ts so a new DeployableStatus value only has to be added once. */

/** Grouping/display order: the four states, then the untriaged bucket. */
export const DEPLOYABLE_ORDER = [...DEPLOYABLE_STATUSES, UNTRIAGED] as const;
export type DeployableKey = StatusKey;
export const DEPLOYABLE_LABEL = STATUS_LABEL;

/** Narrow an untrusted string (a DB value an older client hasn't heard of, or
 *  null) to a known key. Anything unrecognised reads as untriaged rather than
 *  being trusted through. */
export const deployableKey = (s: string | null | undefined): DeployableKey =>
  s && (DEPLOYABLE_ORDER as readonly string[]).includes(s) ? (s as DeployableKey) : UNTRIAGED;

/** Time windows offered by the chart ToggleGroup. `bucket` is chosen so a
 *  window never renders more than ~90 points: a longer window steps up to a
 *  coarser bucket instead of returning an unbounded series. */
export const RANGES = {
  "30d": { days: 30, bucket: "1 day", label: "30 days" },
  "90d": { days: 90, bucket: "1 day", label: "90 days" },
  "6m": { days: 182, bucket: "1 week", label: "6 months" },
  "1y": { days: 365, bucket: "1 month", label: "1 year" },
} as const;

export type RangeKey = keyof typeof RANGES;
export const isRangeKey = (v: string): v is RangeKey => v in RANGES;

/** Category is free text and nullable; uncategorised items group under this
 *  label so they stay visible instead of vanishing from the breakdown. */
export const UNCATEGORIZED = "Uncategorized";

/** `null` = "All Units". A UIC of `""` is normalised to null by the caller. */
export type UicFilter = string | null;

/* ---------- Row shapes returned by the service ---------- */

export type AccountabilitySlice = { accountedFor: boolean; count: number };
export type CategoryKpi = { category: string; deployed: number; ready: number };
export type StatusPoint = { date: string } & Partial<Record<StatusKey, number>>;
export type VelocityPoint = { month: string } & Record<string, string | number>;
export type UnitAllocation = { uic: string; total: number; deployed: number; ready: number };
