import { describe, it, expect } from "vitest";
import { matchContacts, type ContactOption } from "./contact-match";

function c(over: Partial<ContactOption> & { id: string }): ContactOption {
  return {
    rank: null, firstName: "Jane", lastName: "Doe",
    unit: null, contactNumber: null, email: `${over.id}@unit.mil`,
    ...over,
  };
}

// Ordered by last name, as listContacts() returns them. ids are deliberately
// NOT in that same order (3, 1, 2) so an order-preservation assertion can't
// be satisfied by a re-sort-by-id in disguise.
const BOOK: ContactOption[] = [
  c({ id: "3", firstName: "Zoe", lastName: "Alvarez", unit: "A Co", rank: "SGT" }),
  c({ id: "1", firstName: "Jane", lastName: "Doe", unit: "B Co", rank: "SGT", email: "jane.doe@unit.mil" }),
  c({ id: "2", firstName: "Bob", lastName: "Smith", unit: "A Co", rank: "CPL" }),
];

describe("matchContacts", () => {
  it("returns nothing for a blank or whitespace query", () => {
    expect(matchContacts(BOOK, "")).toEqual([]);
    expect(matchContacts(BOOK, "   ")).toEqual([]);
  });

  it("matches on first name", () => {
    expect(matchContacts(BOOK, "zoe").map((x) => x.id)).toEqual(["3"]);
  });

  it("matches on last name", () => {
    expect(matchContacts(BOOK, "smith").map((x) => x.id)).toEqual(["2"]);
  });

  it("matches a full name typed as 'first last'", () => {
    expect(matchContacts(BOOK, "jane doe").map((x) => x.id)).toEqual(["1"]);
  });

  it("matches a full name typed as 'last first'", () => {
    expect(matchContacts(BOOK, "doe jane").map((x) => x.id)).toEqual(["1"]);
  });

  it("matches on email", () => {
    expect(matchContacts(BOOK, "jane.doe@").map((x) => x.id)).toEqual(["1"]);
  });

  it("matches on unit", () => {
    expect(matchContacts(BOOK, "a co").map((x) => x.id)).toEqual(["3", "2"]);
  });

  it("is case-insensitive on both sides", () => {
    expect(matchContacts(BOOK, "ZoE").map((x) => x.id)).toEqual(["3"]);
    expect(matchContacts(BOOK, "  SMITH  ").map((x) => x.id)).toEqual(["2"]);
  });

  it("does NOT match on rank — it would return half the book", () => {
    expect(matchContacts(BOOK, "SGT")).toEqual([]);
  });

  it("does not fuse adjacent fields of the same contact across the seam", () => {
    // haystack() joins a contact's own fields with "\n". Without that
    // separator, this contact's email + unit would concatenate into
    // "...unit.mila co", making the query "mila co" a false-positive match
    // that spans the email/unit boundary. Each half of the seam must still
    // match on its own — that's what proves the fields are genuinely
    // present and the negative assertion isn't just a bogus query.
    const seam = [c({ id: "seam", email: "jane.doe@unit.mil", unit: "A Co" })];
    expect(matchContacts(seam, "mila co")).toEqual([]);
    expect(matchContacts(seam, "unit.mil").map((x) => x.id)).toEqual(["seam"]);
    expect(matchContacts(seam, "a co").map((x) => x.id)).toEqual(["seam"]);
  });

  it("tolerates null unit without matching everything", () => {
    const withNull = [c({ id: "9", unit: null })];
    expect(matchContacts(withNull, "a co")).toEqual([]);
  });

  it("preserves the input (last-name) order of the book", () => {
    expect(matchContacts(BOOK, "co").map((x) => x.id)).toEqual(["3", "1", "2"]);
  });

  it("caps results at the limit, keeping the first n in input order", () => {
    const many = Array.from({ length: 20 }, (_, i) => c({ id: `x${i}`, lastName: "Same" }));
    expect(matchContacts(many, "same").map((x) => x.id)).toEqual(
      Array.from({ length: 8 }, (_, i) => `x${i}`)
    );
    expect(matchContacts(many, "same", 3).map((x) => x.id)).toEqual(["x0", "x1", "x2"]);
  });

  it("returns nothing when limit is zero or negative, instead of unbounded", () => {
    expect(matchContacts(BOOK, "co", 0)).toEqual([]);
    expect(matchContacts(BOOK, "co", -1)).toEqual([]);
  });
});
