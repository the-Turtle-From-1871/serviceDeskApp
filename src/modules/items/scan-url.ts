// Decoded QR text -> item id. Pure: no DOM, no network, no Prisma.
//
// Matches on the PATH and ignores the origin, deliberately. A sticker carries
// whatever defaultBaseUrl() resolved to when it was PRINTED (lib/base-url.ts:5-9):
// APP_URL, else Vercel's injected domain, else "" — which prints a bare
// `/i/{cuid}` with no origin at all. Origin-strict matching would reject
// stickers printed from a preview deploy, from local dev, or before a domain
// change, all of which are physically on hardware.
//
// This is not a security relaxation. The origin was never the check that
// mattered: lookupScannedItem calls requireUser() and resolves the id against
// the database. An id from a wrong-origin sticker either names a real item the
// caller may see, or it does not exist.
//
// The charset is permissive (cuid is [a-z0-9], but uuid has dashes) — the path
// SHAPE is what rejects a foreign code; the DB is what rejects a bad id.
const ITEM_PATH = /^\/i\/([A-Za-z0-9_-]+)\/?$/;

export function parseItemScan(text: string): string | null {
  const raw = text.trim();
  if (!raw) return null;

  let path: string;
  try {
    // Drops any query/hash for free, and yields a non-matching pathname for
    // foreign schemes like `wifi:` (which DOES parse as a URL).
    path = new URL(raw).pathname;
  } catch {
    // Not absolute — this is the bare-path case a local-dev sticker carries.
    path = raw;
  }

  return ITEM_PATH.exec(path)?.[1] ?? null;
}
