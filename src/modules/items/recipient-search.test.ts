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
});
