// Pure: no Prisma, no React, no I/O. The whole book ships to the client with the
// builder page, so matching is a synchronous pass over a few hundred rows —
// which is why the builder needs no debounce, no request race guard, and no
// stale-response handling. Keep this module dependency-free: it is also the seam
// to move behind a server action if the book ever outgrows shipping.

export type ContactOption = {
  id: string;
  rank: string | null;
  firstName: string;
  lastName: string;
  unit: string | null;
  contactNumber: string | null;
  email: string;
};

const MAX_RESULTS = 8;

// Fields joined by "\n" so a query can never match across a field boundary
// ("doe bob" must not fuse one contact's surname to another's given name).
// Both name orders are included so "jane doe" and "doe jane" both hit.
// Rank is deliberately absent: it is low-cardinality, so "SGT" would match half
// the book and bury the contact the user is actually typing toward.
function haystack(c: ContactOption): string {
  return [
    `${c.firstName} ${c.lastName}`,
    `${c.lastName} ${c.firstName}`,
    c.email,
    c.unit ?? "",
  ]
    .join("\n")
    .toLowerCase();
}

/** Contacts whose name, email, or unit contains `query`, in input order. */
export function matchContacts(
  contacts: ContactOption[],
  query: string,
  limit: number = MAX_RESULTS
): ContactOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const out: ContactOption[] = [];
  for (const c of contacts) {
    if (!haystack(c).includes(q)) continue;
    out.push(c);
    if (out.length === limit) break;
  }
  return out;
}
