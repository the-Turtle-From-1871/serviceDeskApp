// Pure sort/group-by-date logic for the Admin Queue. No DB dependency, so it is
// unit-testable without a database.

export type DatedItem = { createdAt: Date };
export type DateGroup<T> = { date: string; items: T[] };

// Calendar-date key (YYYY-MM-DD) in UTC. UTC is used for deterministic grouping
// independent of server timezone; adjust to a fixed display zone at render time
// if calendar-day boundaries need to match a specific locale.
export function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Strictly sort items newest-first and group them into calendar-date buckets.
// Returns groups ordered newest-date-first, each group's items also newest-first
// — mirroring the app-wide `orderBy: { createdAt: "desc" }` convention. Input is
// not mutated.
export function groupByDate<T extends DatedItem>(items: readonly T[]): DateGroup<T>[] {
  const sorted = [...items].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const groups = new Map<string, T[]>();
  for (const item of sorted) {
    const key = dateKey(item.createdAt);
    const bucket = groups.get(key);
    if (bucket) bucket.push(item);
    else groups.set(key, [item]);
  }
  // Map preserves insertion order; since `sorted` is already newest-first, the
  // date keys are encountered (and therefore emitted) newest-first.
  return [...groups.entries()].map(([date, groupItems]) => ({ date, items: groupItems }));
}
