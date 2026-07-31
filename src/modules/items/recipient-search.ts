/**
 * Splitting a recipient search into name tokens.
 *
 * A LEAF module with no imports, for the same reason sort-keys.ts is one:
 * items.service.ts is `server-only` and pulls in Prisma, and this vocabulary is
 * needed by BOTH of listItems' filter implementations (the Prisma `where` and
 * the raw-SQL `itemFilterSql`). One definition is what stops the two paths
 * disagreeing about what a multi-word query means.
 *
 * WHY TOKENS AT ALL: `Transfer.receiverName` is a single free-text String —
 * Contact stores firstName/lastName split and autofill composes "First Last",
 * but operators also type "SGT Smith" and "Doe, Jane". A plain substring match
 * finds "jane", "doe" and "jane doe" against "Jane Doe" but NOT "doe jane".
 * Requiring every token to appear (the caller ANDs them) makes the match
 * order-independent, so first name, last name, or both — in any order — work.
 *
 * PUNCTUATION IS STRIPPED FROM EACH END of a token, and only from the ends.
 * "Doe, Jane" is a normal way to type a name, and splitting on whitespace alone
 * left the comma glued on — so the token "Doe," failed a substring match
 * against a receipt stored as "Jane Doe" and the search found nothing. Only the
 * ENDS are stripped, so names that carry punctuation inside them survive intact:
 * "O'Brien" and "Smith-Jones" are still one token each, and still match.
 *
 * Stripping happens BEFORE the empty filter and the cap, so a token that was
 * nothing but punctuation disappears instead of consuming one of the five slots.
 *
 * The class stripped is "not a letter and not a digit", Unicode-aware (`\p{L}`,
 * `\p{N}` with the `u` flag) rather than an ASCII list — accented and
 * non-Latin names are names, and an ASCII-only rule would mangle them.
 *
 * Only the RECIPIENT branch tokenizes. deviceName/make/model/serialNumber keep
 * matching the whole trimmed query as one pattern, so `dell 5420` behaves
 * exactly as it always has.
 */

/** Hard cap on tokens in one query.
 *
 *  A pasted paragraph would otherwise build an unbounded AND chain, and every
 *  token costs an index probe on both paths. Surplus tokens are DROPPED rather
 *  than rejected: a fat-fingered paste should return more rows than intended,
 *  never an error in a type-ahead. */
export const MAX_RECIPIENT_TOKENS = 5;

/** Leading/trailing run of anything that is not a letter or a digit.
 *  Anchored to both ends only — never the middle — so O'Brien keeps its
 *  apostrophe and Smith-Jones keeps its hyphen. */
const EDGE_PUNCTUATION = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

/** Whitespace-separated name tokens: trimmed, stripped of edge punctuation,
 *  empties removed, capped.
 *  A single-token query yields one token, so it behaves as a plain `contains`. */
export function recipientTokens(search: string): string[] {
  return search
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(EDGE_PUNCTUATION, ""))
    .filter((t) => t !== "")
    .slice(0, MAX_RECIPIENT_TOKENS);
}
