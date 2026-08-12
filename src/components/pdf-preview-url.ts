/**
 * The same PDF URL, asking for a DOWNLOAD rather than an inline render.
 *
 * Two of the three PDF routes switch on a `preview` query param — the receipt
 * PDF and the bulk QR sheet both answer `Content-Disposition: inline` when it
 * is present and `attachment` when it is not — so dropping it is the whole
 * rule. The item QR route (`/i/<id>/qr/pdf`) is inline unconditionally and has
 * no such param; the `download` attribute on the anchor covers that one, which
 * is why this function does not need a special case for it.
 *
 * PURE — parsed against a throwaway base rather than `window.location`, so it
 * never touches the DOM, is safe during a server render, and unit-tests without
 * jsdom. Only the path and query are returned; the base never escapes.
 */
export function downloadHref(src: string): string {
  const url = new URL(src, "http://pdf.invalid");
  url.searchParams.delete("preview");
  return `${url.pathname}${url.search}`;
}
