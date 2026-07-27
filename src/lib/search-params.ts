/**
 * Read one value out of a Next `searchParams` bag.
 *
 * Next supplies `string | string[] | undefined` — an ARRAY whenever a key is
 * repeated (`?uic=A&uic=B`), which any hand-edited or copy-pasted link can do.
 * Typing such a param as plain `string` and calling `.trim()` / `.split()` on
 * it throws a TypeError inside the Server Component, i.e. a 500 for a
 * logged-in user. Route every search param through this first.
 *
 * Last value wins, matching how a duplicate form field would behave.
 */
export function firstParam(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v.length > 0 ? v[v.length - 1] : undefined;
  return v;
}
