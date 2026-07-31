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
 * LIMITATION — punctuation is kept, not stripped: tokens split on whitespace
 * only, so `recipientTokens("Doe, Jane")` yields `["Doe,", "Jane"]` (the comma
 * stays attached to "Doe,"). A query typed as "Doe, Jane" will therefore NOT
 * match a stored "Jane Doe" — the trailing comma makes the "Doe," token fail a
 * substring match against "Jane Doe". Searching for the stored value's own
 * form still works ("Doe," IS a substring of a receipt stored as "Doe,
 * Marcus"). Stripping punctuation would fix this but is a behaviour change,
 * deliberately deferred rather than folded into this fix.
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

/** Whitespace-separated name tokens, trimmed, empties removed, capped.
 *  A single-token query yields one token, so it behaves as a plain `contains`. */
export function recipientTokens(search: string): string[] {
  return search
    .trim()
    .split(/\s+/)
    .filter((t) => t !== "")
    .slice(0, MAX_RECIPIENT_TOKENS);
}
