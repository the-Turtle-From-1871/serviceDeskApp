import { expect, test } from "vitest";
import { parsePartyName } from "./party-name";

test("a comma splits surname from given name", () => {
  expect(parsePartyName("Doe, Jane")).toEqual({ firstName: "Jane", lastName: "Doe" });
  expect(parsePartyName("Doe,Jane")).toEqual({ firstName: "Jane", lastName: "Doe" });
  expect(parsePartyName("  Doe ,  Jane  ")).toEqual({ firstName: "Jane", lastName: "Doe" });
});

test("the FIRST comma splits, so a suffix stays with the surname", () => {
  expect(parsePartyName("Doe Jr., Jane")).toEqual({ firstName: "Jane", lastName: "Doe Jr." });
  // Further commas in the given-name half collapse to spaces rather than
  // leaving punctuation in a stored column.
  expect(parsePartyName("Doe, Jane, Q")).toEqual({ firstName: "Jane Q", lastName: "Doe" });
});

test("with no comma the FIRST token is the given name, keeping compound surnames intact", () => {
  expect(parsePartyName("Jane Doe")).toEqual({ firstName: "Jane", lastName: "Doe" });
  expect(parsePartyName("Jane Van Der Berg")).toEqual({ firstName: "Jane", lastName: "Van Der Berg" });
  expect(parsePartyName("Ana De La Cruz")).toEqual({ firstName: "Ana", lastName: "De La Cruz" });
});

test("the documented trade: two given names misfile", () => {
  // Accepted, not a bug — compound surnames are the commoner case in this
  // fleet, and the result is editable on /admin/users.
  expect(parsePartyName("Maria Jose Cruz")).toEqual({ firstName: "Maria", lastName: "Jose Cruz" });
});

test("internal whitespace collapses so a double space never lands in a column", () => {
  expect(parsePartyName("Jane   Van  Der Berg")).toEqual({ firstName: "Jane", lastName: "Van Der Berg" });
});

test("a name that cannot make two non-empty columns yields null", () => {
  // A Contact requires both firstName and lastName, so there is nothing valid
  // to save here — the caller skips rather than inventing a placeholder.
  expect(parsePartyName("Smith")).toBeNull();
  expect(parsePartyName("")).toBeNull();
  expect(parsePartyName("   ")).toBeNull();
  expect(parsePartyName("Doe,")).toBeNull();
  expect(parsePartyName(", Jane")).toBeNull();
  expect(parsePartyName(",")).toBeNull();
});

test("case is preserved verbatim — nothing reformats a name", () => {
  expect(parsePartyName("DOE, JANE")).toEqual({ firstName: "JANE", lastName: "DOE" });
});
