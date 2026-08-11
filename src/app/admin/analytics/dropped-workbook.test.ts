import { describe, expect, test } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { buildDroppedDevicesWorkbook } from "./dropped-workbook";
import { DROPPED_DEVICE_COLUMNS, type ItemScope, type DroppedDeviceRow } from "./analytics.types";
import { HEADER_TEXT } from "./workbook-style";

/**
 * Reads the produced bytes back, like its sibling — an xlsx is a zip of XML, so
 * the workbook is unzipped and its sheet, styles and shared strings parsed.
 */

const UNSCOPED: ItemScope = { uic: null, unit: null };

function row(over: Partial<DroppedDeviceRow> = {}): DroppedDeviceRow {
  const base = Object.fromEntries(DROPPED_DEVICE_COLUMNS.map((c) => [c, ""])) as DroppedDeviceRow;
  return { ...base, Serial: "SN-1", "Device name": "LAPTOP-1", "MDM record": "Never enrolled", ...over };
}

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

describe("buildDroppedDevicesWorkbook", () => {
  test("produces a real xlsx package", async () => {
    const { names } = open(await buildDroppedDevicesWorkbook([row()], UNSCOPED, false));
    expect(names).toContain("[Content_Types].xml");
    expect(names).toContain("xl/styles.xml");
  });

  test("writes every advertised column", async () => {
    const { sheet, shared } = open(await buildDroppedDevicesWorkbook([row()], UNSCOPED, false));
    for (const column of DROPPED_DEVICE_COLUMNS) expect(shared + sheet).toContain(column);
  });

  test("gives the header row explicit white text, like its sibling", async () => {
    // The shared `textColor` trap: `color` type-checks, builds and is silently
    // discarded, leaving black on the near-black header fill. Both sheets go
    // through workbook-style.ts, and both assert the RESOLVED font.
    const { sheet, styles } = open(await buildDroppedDevicesWorkbook([row()], UNSCOPED, false));
    const rowXml = sheet.match(/<row[^>]*\br="1"[^>]*>([\s\S]*?)<\/row>/)?.[1] ?? "";
    const styleIndex = Number(rowXml.match(/<c[^>]*\bs="(\d+)"/)?.[1]);
    const cellXfs = styles.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? "";
    const xf = [...cellXfs.matchAll(/<xf\b[^>]*\/?>/g)].map((m) => m[0])[styleIndex];
    const fontId = Number(xf?.match(/fontId="(\d+)"/)?.[1] ?? 0);
    const fontsXml = styles.match(/<fonts[^>]*>([\s\S]*?)<\/fonts>/)?.[1] ?? "";
    const font = [...fontsXml.matchAll(/<font>([\s\S]*?)<\/font>/g)].map((m) => m[1])[fontId] ?? "";

    expect(font).toMatch(new RegExp(`<color[^>]*rgb="[0-9A-Fa-f]*${HEADER_TEXT.slice(1)}"`, "i"));
    expect(font).not.toMatch(/<color[^>]*theme=/);
  });

  test("does NOT colour the data rows", async () => {
    // Deliberate divergence from the dormant sheet: every device here has no
    // sync time, so there is no age to band. Shading would invent a severity
    // the data does not carry. If banding is ever wanted, it needs a rule
    // first — this asserts nobody added one by reflex.
    const { sheet, styles } = open(
      await buildDroppedDevicesWorkbook([row(), row({ "MDM record": "Dropped out" })], UNSCOPED, false),
    );
    const fillsXml = styles.match(/<fills[^>]*>([\s\S]*?)<\/fills>/)?.[1] ?? "";
    const fills = [...fillsXml.matchAll(/<fill>([\s\S]*?)<\/fill>/g)].map((m) => m[1]);
    const cellXfs = styles.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? "";
    const xfs = [...cellXfs.matchAll(/<xf\b[^>]*\/?>/g)].map((m) => m[0]);

    for (const r of [2, 3]) {
      const rowXml = sheet.match(new RegExp(`<row[^>]*\\br="${r}"[^>]*>([\\s\\S]*?)</row>`))?.[1] ?? "";
      const styleIndex = rowXml.match(/<c[^>]*\bs="(\d+)"/)?.[1];
      // Either no style at all, or one whose fill declares no colour.
      if (styleIndex === undefined) continue;
      const fillId = Number(xfs[Number(styleIndex)]?.match(/fillId="(\d+)"/)?.[1] ?? 0);
      expect(fills[fillId] ?? "").not.toMatch(/<fgColor[^>]*rgb=/);
    }
  });

  test("says how the list splits, in the file", async () => {
    // The sheet is mailed on to people who never saw the card. A wall of rows
    // titled "dropped off the network" that is mostly devices which were never
    // enrolled would be read as 164 emergencies.
    const { sheet, shared } = open(
      await buildDroppedDevicesWorkbook(
        [row({ "MDM record": "Dropped out" }), row(), row()],
        UNSCOPED,
        false,
      ),
    );
    const haystack = shared + sheet;
    expect(haystack).toContain("1 dropped out");
    expect(haystack).toContain("2 never enrolled");
  });

  test("says in the file when the export was capped", async () => {
    const { sheet, shared } = open(await buildDroppedDevicesWorkbook([row()], UNSCOPED, true));
    expect(shared + sheet).toContain("capped");
  });
});
