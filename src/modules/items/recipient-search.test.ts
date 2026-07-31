import { describe, it, expect } from "vitest";
import { recipientTokens, MAX_RECIPIENT_TOKENS } from "./recipient-search";

describe("recipientTokens", () => {
  it("returns a single token unchanged, so a one-word query is a plain contains", () => {
    expect(recipientTokens("doe")).toEqual(["doe"]);
  });

  it("splits a full name into its parts", () => {
    expect(recipientTokens("jane doe")).toEqual(["jane", "doe"]);
  });

  // The tokens are AND'd by the caller, so the ORDER they come back in does not
  // matter to matching — but they must all be present. This is what makes
  // "doe jane" find "Jane Doe": the requirement is set membership, not sequence.
  it("keeps every token when the name is typed surname-first", () => {
    expect(recipientTokens("doe jane").sort()).toEqual(["doe", "jane"]);
  });

  it("collapses runs of whitespace and trims the ends", () => {
    expect(recipientTokens("  jane   doe \t")).toEqual(["jane", "doe"]);
  });

  it("returns nothing for a blank or whitespace-only query", () => {
    expect(recipientTokens("")).toEqual([]);
    expect(recipientTokens("   ")).toEqual([]);
  });

  // A pasted paragraph must not build an unbounded AND chain. Dropping the
  // surplus (rather than erroring) keeps a fat-fingered paste returning MORE
  // rows, never a failure.
  it("caps the token count, keeping the first MAX_RECIPIENT_TOKENS", () => {
    expect(MAX_RECIPIENT_TOKENS).toBe(5);
    expect(recipientTokens("a b c d e f g")).toEqual(["a", "b", "c", "d", "e"]);
  });

  // "Doe, Jane" is an ordinary way to type a name. Splitting on whitespace
  // alone left the comma glued on, so the token "Doe," could not substring-match
  // a receipt stored as "Jane Doe" and the search silently found nothing.
  it("strips punctuation from the ends of a token, so 'Doe, Jane' finds 'Jane Doe'", () => {
    expect(recipientTokens("Doe, Jane")).toEqual(["Doe", "Jane"]);
    expect(recipientTokens("(Smith)")).toEqual(["Smith"]);
    expect(recipientTokens("doe.")).toEqual(["doe"]);
  });

  // Only the ENDS. A name's own punctuation is part of the name — stripping it
  // everywhere would turn "O'Brien" into "OBrien" and match nothing at all.
  it("keeps punctuation INSIDE a token", () => {
    expect(recipientTokens("O'Brien")).toEqual(["O'Brien"]);
    expect(recipientTokens("Smith-Jones")).toEqual(["Smith-Jones"]);
    expect(recipientTokens("jane.doe@unit.mil")).toEqual(["jane.doe@unit.mil"]);
  });

  // Stripping runs BEFORE the empty filter and the cap, so a token that was
  // nothing but punctuation vanishes instead of eating one of the five slots.
  it("drops a token that was punctuation only, without spending a slot", () => {
    expect(recipientTokens("jane - doe")).toEqual(["jane", "doe"]);
    expect(recipientTokens(",,,")).toEqual([]);
    expect(recipientTokens("- a b c d e")).toEqual(["a", "b", "c", "d", "e"]);
  });

  // Names are not ASCII. An ASCII-only strip class would eat the letters it was
  // meant to protect, so the rule is "not a letter and not a digit", Unicode-aware.
  it("treats accented and non-Latin letters as letters, not punctuation", () => {
    expect(recipientTokens("Muñoz")).toEqual(["Muñoz"]);
    expect(recipientTokens("Þórsdóttir,")).toEqual(["Þórsdóttir"]);
    expect(recipientTokens("李")).toEqual(["李"]);
  });

  // Digits survive: a receipt can name a unit or a number, and serials reach
  // this function too whenever someone pastes one into the search box.
  it("keeps digits", () => {
    expect(recipientTokens("SGT 1st Doe")).toEqual(["SGT", "1st", "Doe"]);
  });
});
