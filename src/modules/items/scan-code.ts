// Decoded barcode text -> what we should look up. Pure: no DOM, no network,
// no Prisma — same contract as scan-url.ts, which this WRAPS rather than
// replaces (that file stays the authority on our own QR sticker).
//
// Three things can be under the camera:
//   * the QR sticker this app prints, carrying an /i/<id> URL;
//   * a manufacturer's factory barcode, carrying a bare serial;
//   * a manufacturer's factory QR, carrying SEVERAL FIELDS one of which is the
//     serial. HP prints a comma-separated list with the bare serial first
//     (`2TK94709FN, HP ProBook 650 G5, ProdID …`); a keyed `SN:` form is also
//     handled, because it costs little and other vendors use it.
import { parseItemScan } from "./scan-url";

export type ScanIntent =
  | { kind: "item"; id: string }
  | {
      kind: "serial";
      serial: string;
      altSerial?: string;
      /** Make/model read off the label, for PREFILLING a create form only.
       *  Never used to look anything up. */
      label?: { make: string; model: string };
    };

// A shape filter, NOT a security control — it exists so a stray barcode costs
// no round trip. The DB is the authority on whether a serial names an item,
// exactly as scan-url.ts says of its own regex.
//
// Grounded in the fleet, re-censused 2026-08-11 across all 1,204 items and
// every make in the book — HP 731, Dell 413, Microsoft 35, Getac 24:
//   * ZERO carry a non-alphanumeric character;
//   * ZERO fall outside 4-20 characters (lengths are Dell 7, HP 10, Getac 10,
//     Surface 14 — each make uniform to the character);
//   * ZERO are all digits.
// So this filter accepts 100% of the property book: it can never be the reason
// a real device fails to scan. That last line is also what makes the Dell
// express-code conversion below safe — a scan of pure digits cannot be a
// genuine numeric serial, because the fleet contains none.
// `scan-code.test.ts` pins one serial per make so narrowing this range would
// fail loudly rather than silently stranding a vendor.
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

// Fields are separated by punctuation or whitespace; the KEY:VALUE pair itself
// is split on the first ":" or "=". Whitespace counts as a separator because HP
// prints space-delimited pairs on some labels — a serial never contains one.
const FIELD_SEPARATOR = /[\s;,|]+/;
const FIELD_PAIR = /^([A-Za-z][A-Za-z0-9 /_-]*?)[:=](\S+)$/;

// Only these keys name a serial. Compared with punctuation stripped and folded
// to upper case, so "S/N", "Serial Number" and "sn" all land here.
const SERIAL_KEYS = new Set(["SN", "SERIAL", "SERIALNO", "SERIALNUM", "SERIALNUMBER", "SERNO"]);

/**
 * Pull the serial out of a delimited field string like
 * `SN:2TK44202X4;PN:1AB23AV#ABA`.
 *
 * Deliberately keyed on an explicit serial FIELD NAME rather than scanning for
 * a serial-shaped token anywhere in the payload. A loose scan would read the
 * Dell PPID `CN-0ABCDE-12345-ABC-1234-A00` as "0ABCDE", and would happily
 * return a product number — which is shared across thousands of units, so it
 * either matches nothing or names the wrong machine. An unrecognised key is a
 * miss, not a guess: the operator gets "Not an item code" and the label can be
 * typed in, which beats confidently opening some other device's page.
 */
function serialFromFields(raw: string): string | null {
  for (const part of raw.split(FIELD_SEPARATOR)) {
    const pair = FIELD_PAIR.exec(part);
    if (!pair) continue;
    const key = pair[1].replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    // The value still has to look like a serial — that check is what keeps a
    // "SN:" field carrying something unexpected from reaching the database.
    if (SERIAL_KEYS.has(key) && SERIAL_SHAPE.test(pair[2])) return pair[2];
  }
  return null;
}

/**
 * The first value in ONE camera frame that names something we can look up.
 *
 * A manufacturer's service label is not one code — HP's carries a QR beside a
 * Code 128 serial and a product-number barcode, and the decoder returns every
 * one it can see in the frame. Taking only the first hit meant a label whose
 * QR was not first never reached the parser at all, whatever the QR contained.
 */
export function parseScans(texts: readonly string[]): ScanIntent | null {
  for (const text of texts) {
    const intent = parseScan(text);
    if (intent) return intent;
  }
  return null;
}

const SAMPLE_MAX = 40;
const SAMPLE_COUNT = 2;

/**
 * What the camera read, for the operator-facing notice when NOTHING in the
 * frame parsed. Showing it turns "Not an item code" from a dead end into
 * something the operator can read out — an unrecognised label is then a
 * one-line change here rather than a support round trip.
 *
 * Flattened and truncated: a payload can carry newlines and run long, and the
 * notice is a single line over the video sheet.
 */
export function describeScan(texts: readonly string[]): string {
  const shown = texts.slice(0, SAMPLE_COUNT).map((text) => {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > SAMPLE_MAX ? `${flat.slice(0, SAMPLE_MAX)}…` : flat;
  });
  const rest = texts.length - shown.length;
  return rest > 0 ? `${shown.join(" · ")} (+${rest} more)` : shown.join(" · ");
}

/**
 * Pull the serial out of a comma-separated list like
 * `2TK94709FN, HP ProBook 650 G5, ProdID 5PF3AB#ABA` — what HP actually prints
 * in its service-label QR. The serial is the first field and carries no key,
 * which is why the keyed parser above never matched it.
 *
 * The split is on COMMAS ALONE, and that narrowness is the safety property: a
 * whole field has to BE a serial, so no fragment of a longer string can ever
 * be mistaken for one. The Dell PPID `CN-0ABCDE-12345-ABC-1234-A00` contains
 * no comma, so it stays one field, keeps its hyphens and is still refused —
 * splitting on whitespace or hyphens too would have handed back `0ABCDE`.
 *
 * Requires an actual comma: a single-field payload that is a serial was
 * already taken by the bare-serial path, so reaching here without one means
 * the payload is something else entirely.
 */
function serialFieldFromList(raw: string): { serial: string; fields: string[]; at: number } | null {
  const fields = raw.split(/\s*,\s*/);
  if (fields.length < 2) return null;
  const at = fields.findIndex((field) => SERIAL_SHAPE.test(field));
  return at === -1 ? null : { serial: fields[at], fields, at };
}

/**
 * The device description HP prints beside the serial —
 * `2TK94709FN, HP ProBook 650 G5, ProdID …`. The stored row for that serial is
 * make "HP", model "HP ProBook 650 G5", so the MODEL is the whole field and the
 * MAKE is its first token; that is how this data is actually shaped.
 *
 * The field immediately after the serial, and only if it is NOT itself
 * serial-shaped — a list of two serials describes nothing.
 */
function labelHint(fields: string[], at: number): { make: string; model: string } | undefined {
  const desc = fields[at + 1]?.trim();
  if (!desc || SERIAL_SHAPE.test(desc)) return undefined;
  const make = desc.split(/\s+/)[0];
  return make ? { make, model: desc } : undefined;
}

export function parseScan(text: string): ScanIntent | null {
  const raw = text.trim();
  if (!raw) return null;

  // Our own sticker wins: it names an item directly and needs no guessing.
  const id = parseItemScan(raw);
  if (id) return { kind: "item", id };

  // A bare serial stays the fast path and is unchanged, so a label that already
  // scans keeps scanning exactly as it did. Otherwise the payload is a list of
  // fields: a KEYED serial is stronger evidence than a positional one, so it is
  // tried first, and only then the "first field that is a serial" rule.
  let serial = SERIAL_SHAPE.test(raw) ? raw : serialFromFields(raw);
  let label: { make: string; model: string } | undefined;
  if (!serial) {
    const list = serialFieldFromList(raw);
    if (list) {
      serial = list.serial;
      label = labelHint(list.fields, list.at);
    }
  }
  if (!serial) return null;

  // The raw value is the PRIMARY candidate and the conversion only ever an
  // alternative. Preferring the conversion would rewrite a genuinely numeric
  // 10-digit serial into a 7-character tag that names a different machine —
  // trying raw first makes that unrepresentable, at the cost of one extra
  // query only when the raw value misses.
  const altSerial = expressServiceCodeToServiceTag(serial);
  return {
    kind: "serial",
    serial,
    ...(altSerial ? { altSerial } : {}),
    ...(label ? { label } : {}),
  };
}
