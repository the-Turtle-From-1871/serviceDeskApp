import { describe, it, expect } from "vitest";
import { parseSortKeys, MAX_SORT_KEYS } from "./items.service";

// parseSortKeys turns untrusted querystring text into an ORDER BY list, so its
// job is as much rejection as parsing.
describe("parseSortKeys", () => {
  it("returns nothing when no sort is given", () => {
    expect(parseSortKeys(null, null)).toEqual([]);
    expect(parseSortKeys(undefined, "asc")).toEqual([]);
    expect(parseSortKeys("", "asc")).toEqual([]);
  });

  it("parses a single key", () => {
    expect(parseSortKeys("make", "asc")).toEqual([{ key: "make", dir: "asc" }]);
  });

  it("pairs a compound sort with its directions positionally", () => {
    expect(parseSortKeys("make,serialNumber", "asc,desc")).toEqual([
      { key: "make", dir: "asc" },
      { key: "serialNumber", dir: "desc" },
    ]);
  });

  it("falls back to the FIRST direction when later ones are missing", () => {
    // `?sort=make,serialNumber&dir=asc` reads as "both ascending" to a human;
    // defaulting the tail to desc would silently contradict that.
    expect(parseSortKeys("make,serialNumber", "asc")).toEqual([
      { key: "make", dir: "asc" },
      { key: "serialNumber", dir: "asc" },
    ]);
  });

  it("defaults to desc when no direction is supplied at all", () => {
    expect(parseSortKeys("make", null)).toEqual([{ key: "make", dir: "desc" }]);
  });

  it("drops unknown columns so they can never reach Prisma", () => {
    // The obvious injection attempt: a column that does not exist, or an
    // attempt to sort by a sensitive one.
    expect(parseSortKeys("passwordHash", "asc")).toEqual([]);
    expect(parseSortKeys("make,passwordHash,serialNumber", "asc,asc,asc")).toEqual([
      { key: "make", dir: "asc" },
      { key: "serialNumber", dir: "asc" },
    ]);
  });

  it("ignores an invalid direction token rather than passing it through", () => {
    expect(parseSortKeys("make", "sideways")).toEqual([{ key: "make", dir: "desc" }]);
  });

  it("collapses duplicate keys to their first occurrence", () => {
    // Otherwise `sort=make,make&dir=asc,desc` yields a contradictory ORDER BY.
    expect(parseSortKeys("make,make", "asc,desc")).toEqual([{ key: "make", dir: "asc" }]);
  });

  it("caps the number of keys", () => {
    const keys = parseSortKeys(
      "make,model,serialNumber,deviceName,status",
      "asc,asc,asc,asc,asc",
    );
    expect(keys).toHaveLength(MAX_SORT_KEYS);
  });

  it("tolerates whitespace and empty segments", () => {
    expect(parseSortKeys(" make , , serialNumber ", " asc , , desc ")).toEqual([
      { key: "make", dir: "asc" },
      { key: "serialNumber", dir: "desc" },
    ]);
  });
});
