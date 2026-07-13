import { describe, it, expect } from "vitest";
import { groupByDate, dateKey } from "./service-queue.group";

const at = (iso: string) => ({ createdAt: new Date(iso), tag: iso });

describe("dateKey", () => {
  it("returns the UTC calendar date (YYYY-MM-DD)", () => {
    expect(dateKey(new Date("2026-07-13T23:59:00.000Z"))).toBe("2026-07-13");
  });
});

describe("groupByDate", () => {
  it("groups items by calendar date", () => {
    const groups = groupByDate([
      at("2026-07-13T09:00:00.000Z"),
      at("2026-07-12T10:00:00.000Z"),
      at("2026-07-13T15:00:00.000Z"),
    ]);
    expect(groups.map((g) => g.date)).toEqual(["2026-07-13", "2026-07-12"]);
    expect(groups[0].items).toHaveLength(2);
    expect(groups[1].items).toHaveLength(1);
  });

  it("orders groups newest-date-first and items newest-first within a group", () => {
    const groups = groupByDate([
      at("2026-07-12T08:00:00.000Z"),
      at("2026-07-13T08:00:00.000Z"),
      at("2026-07-13T20:00:00.000Z"),
    ]);
    expect(groups.map((g) => g.date)).toEqual(["2026-07-13", "2026-07-12"]);
    expect(groups[0].items.map((i) => i.tag)).toEqual([
      "2026-07-13T20:00:00.000Z",
      "2026-07-13T08:00:00.000Z",
    ]);
  });

  it("returns an empty array for no items and does not mutate the input", () => {
    const input = [at("2026-07-13T09:00:00.000Z"), at("2026-07-11T09:00:00.000Z")];
    const snapshot = input.map((i) => i.tag);
    groupByDate(input);
    expect(input.map((i) => i.tag)).toEqual(snapshot);
    expect(groupByDate([])).toEqual([]);
  });
});
