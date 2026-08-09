// Decoded barcode text -> what we should look up. Pure: no DOM, no network,
// no Prisma — same contract as scan-url.ts, which this WRAPS rather than
// replaces (that file stays the authority on our own QR sticker).
//
// Two things can be under the camera:
//   * the QR sticker this app prints, carrying an /i/<id> URL;
//   * a manufacturer's factory barcode, carrying a serial.
import { parseItemScan } from "./scan-url";

export type ScanIntent =
  | { kind: "item"; id: string }
  | { kind: "serial"; serial: string; altSerial?: string };

// A shape filter, NOT a security control — it exists so a stray barcode costs
// no round trip. The DB is the authority on whether a serial names an item,
// exactly as scan-url.ts says of its own regex.
//
// Grounded in the fleet: of 1,204 ACTIVE items, ZERO carry a non-alphanumeric
// character and lengths run 4-14 (Dell 7, HP 10, Surface 14, Getac 10).
const SERIAL_SHAPE = /^[A-Za-z0-9]{4,20}$/;

// A 7-char service tag is 36^6 .. 36^7-1, i.e. 10 or 11 digits. A tag starting
// with "0" is worth less and lands as few as 8 — hence the wider floor.
const EXPRESS_CODE = /^[0-9]{8,11}$/;

/**
 * Dell prints the Service Tag and the Express Service Code as two barcodes a
 * centimetre apart, and they are the SAME value in two bases: a service tag is
 * 7 characters of base 36, and the express code is that number in base 10.
 * Converting means the operator can hit either barcode and never notice.
 *
 * Returns null for anything that is not an express code, or that does not
 * convert back to exactly 7 tag characters.
 */
export function expressServiceCodeToServiceTag(code: string): string | null {
  if (!EXPRESS_CODE.test(code)) return null;

  // BigInt, not Number: 36^7-1 is ~7.8e10, which is inside Number's safe
  // integer range today, but the parse/format round trip is exact with BigInt
  // and needs no reasoning about precision.
  const tag = BigInt(code).toString(36).toUpperCase();
  if (tag.length > 7) return null;

  // Load-bearing. A tag beginning with "0" has no leading zero in the numeric
  // form, so the conversion comes back one character short; padding restores
  // it. Without this, "623698779" yields "ABC123" and matches no item.
  return tag.padStart(7, "0");
}

export function parseScan(text: string): ScanIntent | null {
  const raw = text.trim();
  if (!raw) return null;

  // Our own sticker wins: it names an item directly and needs no guessing.
  const id = parseItemScan(raw);
  if (id) return { kind: "item", id };

  if (!SERIAL_SHAPE.test(raw)) return null;

  // The raw value is the PRIMARY candidate and the conversion only ever an
  // alternative. Preferring the conversion would rewrite a genuinely numeric
  // 10-digit serial into a 7-character tag that names a different machine —
  // trying raw first makes that unrepresentable, at the cost of one extra
  // query only when the raw value misses.
  const altSerial = expressServiceCodeToServiceTag(raw);
  return altSerial ? { kind: "serial", serial: raw, altSerial } : { kind: "serial", serial: raw };
}
