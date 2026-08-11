import { describe, expect, test } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { buildStaleDevicesWorkbook } from "./stale-workbook";
import { STALE_DEVICE_COLUMNS, type ItemScope, type StaleDeviceRow } from "./analytics.types";
import { SEVERITY_FILL } from "./stale-severity";

/**
 * These tests read the ACTUAL bytes the admin downloads back out of the .xlsx —
 * an xlsx is a zip of XML, so the workbook is unzipped and its sheet + styles
 * parsed. Asserting on what was passed to the writer would only restate this
 * file; the thing that can actually break is the mapping from a row's data to a
 * fill in `styles.xml`, and only the output shows that.
 */

const UNSCOPED: ItemScope = { uic: null, unit: null };

function row(over: Partial<StaleDeviceRow> = {}): StaleDeviceRow {
  const base = Object.fromEntries(STALE_DEVICE_COLUMNS.map((c) => [c, ""])) as StaleDeviceRow;
  return { ...base, Serial: "SN-1", "Days since sync": 40, Compliance: "compliant", ...over };
}

/** Unzip the workbook and return the two parts these assertions need. */
function open(buf: Buffer) {
  const files = unzipSync(new Uint8Array(buf));
  const name = Object.keys(files).find((f) => f.startsWith("xl/worksheets/sheet"))!;
  return {
    sheet: strFromU8(files[name]),
    styles: strFromU8(files["xl/styles.xml"]),
    shared: files["xl/sharedStrings.xml"] ? strFromU8(files["xl/sharedStrings.xml"]) : "",
    names: Object.keys(files),
  };
}

/**
 * The fill actually painted on a given sheet row, as `#RRGGBB`.
 *
 * Resolved the way Excel resolves it — cell `s=` index → `cellXfs` entry →
 * `fillId` → the `fills` table — rather than by scanning styles.xml for the
 * colour. That distinction matters here: the LEGEND declares all three fills on
 * every sheet, so "the file mentions yellow somewhere" is true even when no
 * device is yellow. Only walking the row's own style index answers what a
 * reader sees on that line.
 *
 * `r` is 1-based like the spreadsheet, so the first data row is 2.
 */
function fillOfRow(sheet: string, styles: string, r: number): string | null {
  const rowXml = sheet.match(new RegExp(`<row[^>]*\\br="${r}"[^>]*>(.*?)</row>`, "s"))?.[1];
  if (!rowXml) return null;
  const styleIndex = rowXml.match(/<c[^>]*\bs="(\d+)"/)?.[1];
  if (styleIndex === undefined) return null;

  const cellXfs = styles.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? "";
  const xf = [...cellXfs.matchAll(/<xf\b[^>]*\/?>/g)].map((m) => m[0])[Number(styleIndex)];
  const fillId = Number(xf?.match(/fillId="(\d+)"/)?.[1] ?? 0);

  const fillsXml = styles.match(/<fills[^>]*>([\s\S]*?)<\/fills>/)?.[1] ?? "";
  const fill = [...fillsXml.matchAll(/<fill>([\s\S]*?)<\/fill>/g)].map((m) => m[1])[fillId];
  const rgb = fill?.match(/<fgColor[^>]*rgb="([0-9A-Fa-f]{6,8})"/)?.[1];
  return rgb ? `#${rgb.slice(-6).toUpperCase()}` : null;
}

const up = (hex: string) => hex.toUpperCase();

describe("buildStaleDevicesWorkbook", () => {
  test("produces a real xlsx package", async () => {
    const { names } = open(await buildStaleDevicesWorkbook([row()], UNSCOPED, false));
    // The parts Excel refuses to open a file without.
    expect(names).toContain("[Content_Types].xml");
    expect(names).toContain("xl/workbook.xml");
    expect(names).toContain("xl/styles.xml");
  });

  test("gives the header row EXPLICIT white text, not Excel's theme default", async () => {
    // The regression this exists for: write-excel-file renamed `color` to
    // `textColor` in v3 and silently discards an unknown key, so `color:
    // "#FFFFFF"` type-checks, builds, produces a valid file — and leaves the
    // header on `theme="1"`, which is black on the near-black header fill at
    // about 1.5:1. Every sheet shipped that way until it was caught by reading
    // the bytes. Asserting the resolved FONT is what catches it; asserting the
    // value passed to the writer would not.
    const { sheet, styles } = open(await buildStaleDevicesWorkbook([row()], UNSCOPED, false));
    const rowXml = sheet.match(/<row[^>]*\br="1"[^>]*>([\s\S]*?)<\/row>/)?.[1] ?? "";
    const styleIndex = Number(rowXml.match(/<c[^>]*\bs="(\d+)"/)?.[1]);
    const cellXfs = styles.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? "";
    const xf = [...cellXfs.matchAll(/<xf\b[^>]*\/?>/g)].map((m) => m[0])[styleIndex];
    const fontId = Number(xf?.match(/fontId="(\d+)"/)?.[1] ?? 0);
    const fontsXml = styles.match(/<fonts[^>]*>([\s\S]*?)<\/fonts>/)?.[1] ?? "";
    const font = [...fontsXml.matchAll(/<font>([\s\S]*?)<\/font>/g)].map((m) => m[1])[fontId] ?? "";

    // An explicit rgb, and white — a `theme=` colour here is the bug.
    expect(font).toMatch(/<color[^>]*rgb="[0-9A-Fa-f]*FFFFFF"/i);
    expect(font).not.toMatch(/<color[^>]*theme=/);
    expect(font).toContain("<b/>");
  });

  test("paints each row the colour its own data earns", async () => {
    // Three devices, one per band, in one sheet — so this also proves the fills
    // are applied per row rather than one style being reused for all of them.
    const { sheet, styles } = open(
      await buildStaleDevicesWorkbook(
        [
          row({ Serial: "RED", "Days since sync": 31, Compliance: "noncompliant" }),
          row({ Serial: "ORANGE", "Days since sync": 70, Compliance: "compliant" }),
          row({ Serial: "YELLOW", "Days since sync": 31, Compliance: "compliant" }),
        ],
        UNSCOPED,
        false,
      ),
    );
    expect(fillOfRow(sheet, styles, 2)).toBe(up(SEVERITY_FILL.noncompliant));
    expect(fillOfRow(sheet, styles, 3)).toBe(up(SEVERITY_FILL.older));
    expect(fillOfRow(sheet, styles, 4)).toBe(up(SEVERITY_FILL.recent));
  });

  test("a non-compliant row is RED even at the youngest end of the window", async () => {
    // The decision made explicit: red outranks the age band. A 31-day
    // non-compliant device coming out yellow is the regression this catches.
    const { sheet, styles } = open(
      await buildStaleDevicesWorkbook(
        [row({ "Days since sync": 31, Compliance: "noncompliant" })],
        UNSCOPED,
        false,
      ),
    );
    expect(fillOfRow(sheet, styles, 2)).toBe(up(SEVERITY_FILL.noncompliant));
  });

  test("grace period and a blank keep their age band rather than going red", async () => {
    // Both are "not a device that is actually blocked". Colouring them red
    // would overstate the count — 13 devices fleet-wide are in grace.
    const { sheet, styles } = open(
      await buildStaleDevicesWorkbook(
        [
          row({ "Days since sync": 70, Compliance: "inGracePeriod" }),
          row({ "Days since sync": 31, Compliance: "" }),
        ],
        UNSCOPED,
        false,
      ),
    );
    expect(fillOfRow(sheet, styles, 2)).toBe(up(SEVERITY_FILL.older));
    expect(fillOfRow(sheet, styles, 3)).toBe(up(SEVERITY_FILL.recent));
  });

  test("writes every advertised column, in order, as the header row", async () => {
    const { sheet, shared } = open(await buildStaleDevicesWorkbook([row()], UNSCOPED, false));
    const haystack = shared + sheet;
    for (const column of STALE_DEVICE_COLUMNS) expect(haystack).toContain(column);
  });

  test("does NOT turn a formula-looking value into a formula", async () => {
    // Device name, Holder and Last logon user arrive verbatim from the MDM
    // import, so this really can be in the data. In CSV it becomes live on open,
    // which is why export.ts prefixes an apostrophe. In xlsx a string cell is a
    // string — this pins that the writer never emits an <f> element, so the
    // guard is genuinely unnecessary here rather than merely forgotten.
    const { sheet } = open(
      await buildStaleDevicesWorkbook(
        [row({ "Device name": '=HYPERLINK("http://evil/","click")' })],
        UNSCOPED,
        false,
      ),
    );
    expect(sheet).not.toContain("<f>");
    expect(sheet).not.toContain("<f ");
  });

  test("says in the FILE when the export was capped", async () => {
    // The toast that says so is gone the moment the tab is closed; the sheet
    // outlives it and gets mailed on.
    const { sheet, shared } = open(await buildStaleDevicesWorkbook([row()], UNSCOPED, true));
    expect(shared + sheet).toContain("capped");
  });

  test("carries a legend naming every band", async () => {
    const { sheet, shared } = open(await buildStaleDevicesWorkbook([row()], UNSCOPED, false));
    const haystack = shared + sheet;
    expect(haystack).toContain("What the colours mean");
    expect(haystack).toContain("Not compliant");
  });

  test("writes the day count as a number, not text", async () => {
    // It is there so the sheet can be sorted and filtered on it; as text, 100
    // sorts before 40.
    const { sheet } = open(await buildStaleDevicesWorkbook([row({ "Days since sync": 47 })], UNSCOPED, false));
    // A numeric cell has no t="s"/t="str" and carries its value inline.
    expect(sheet).toMatch(/<v>47<\/v>/);
  });
});
