import { describe, it, expect } from "vitest";
import { matchContacts, type ContactOption } from "./contact-match";

function c(over: Partial<ContactOption> & { id: string }): ContactOption {
  return {
    rank: null, firstName: "Jane", lastName: "Doe",
    unit: null, contactNumber: null, email: `${over.id}@unit.mil`,
    ...over,
  };
}

// Ordered by last name, as listContacts() returns them.
const BOOK: ContactOption[] = [
  c({ id: "1", firstName: "Zoe", lastName: "Alvarez", unit: "A Co", rank: "SGT" }),
  c({ id: "2", firstName: "Jane", lastName: "Doe", unit: "B Co", rank: "SGT", email: "jane.doe@unit.mil" }),
  c({ id: "3", firstName: "Bob", lastName: "Smith", unit: "A Co", rank: "CPL" }),
];

describe("matchContacts", () => {
  it("returns nothing for a blank or whitespace query", () => {
    expect(matchContacts(BOOK, "")).toEqual([]);
    expect(matchContacts(BOOK, "   ")).toEqual([]);
  });

  it("matches on first name", () => {
    expect(matchContacts(BOOK, "zoe").map((x) => x.id)).toEqual(["1"]);
  });

  it("matches on last name", () => {
    expect(matchContacts(BOOK, "smith").map((x) => x.id)).toEqual(["3"]);
  });

  it("matches a full name typed as 'first last'", () => {
    expect(matchContacts(BOOK, "jane doe").map((x) => x.id)).toEqual(["2"]);
  });

  it("matches a full name typed as 'last first'", () => {
    expect(matchContacts(BOOK, "doe jane").map((x) => x.id)).toEqual(["2"]);
  });

  it("matches on email", () => {
    expect(matchContacts(BOOK, "jane.doe@").map((x) => x.id)).toEqual(["2"]);
  });

  it("matches on unit", () => {
    expect(matchContacts(BOOK, "a co").map((x) => x.id)).toEqual(["1", "3"]);
  });

  it("is case-insensitive on both sides", () => {
    expect(matchContacts(BOOK, "ZoE").map((x) => x.id)).toEqual(["1"]);
    expect(matchContacts(BOOK, "  SMITH  ").map((x) => x.id)).toEqual(["3"]);
  });

  it("does NOT match on rank — it would return half the book", () => {
    expect(matchContacts(BOOK, "SGT")).toEqual([]);
  });

  it("does not match across field boundaries", () => {
    // "doe" (last of #2) + "bob" (first of #3) must not fuse into a hit.
    expect(matchContacts(BOOK, "doe bob")).toEqual([]);
  });

  it("tolerates null unit without matching everything", () => {
    const withNull = [c({ id: "9", unit: null })];
    expect(matchContacts(withNull, "a co")).toEqual([]);
  });

  it("preserves the input (last-name) order of the book", () => {
    expect(matchContacts(BOOK, "co").map((x) => x.id)).toEqual(["1", "2", "3"]);
  });

  it("caps results at the limit", () => {
    const many = Array.from({ length: 20 }, (_, i) => c({ id: `x${i}`, lastName: "Same" }));
    expect(matchContacts(many, "same")).toHaveLength(8);
    expect(matchContacts(many, "same", 3)).toHaveLength(3);
  });
});
