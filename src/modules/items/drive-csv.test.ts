import { describe, it, expect } from "vitest";
import { checkDriveCsvBody, csvSourceHash, MAX_CSV_BYTES } from "./drive-csv";

const CSV = "make,model,serialNumber\nDell,7440,SN-1\n";

describe("csvSourceHash", () => {
  it("is stable for identical content", () => {
    expect(csvSourceHash(CSV)).toBe(csvSourceHash(CSV));
  });

  it("differs when a single cell changes", () => {
    expect(csvSourceHash(CSV)).not.toBe(csvSourceHash(CSV.replace("SN-1", "SN-2")));
  });

  // The whole point of hashing rather than trusting Drive's modifiedTime: an
  // export regenerated nightly gets a new timestamp even when the fleet is
  // identical, so only content can answer "is this actually a new export?".
  it("is unchanged by re-uploading byte-identical content", () => {
    const reuploaded = `${CSV}`;
    expect(csvSourceHash(reuploaded)).toBe(csvSourceHash(CSV));
  });
});

describe("checkDriveCsvBody", () => {
  it("accepts a CSV body and returns its hash", () => {
    const res = checkDriveCsvBody(CSV, "text/csv");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toBe(CSV);
    expect(res.hash).toBe(csvSourceHash(CSV));
  });

  it("accepts a CSV served with no content-type at all", () => {
    // Drive's direct-download URL is not a documented API and has changed its
    // headers before. A missing content-type must not be treated as failure —
    // the body-shape checks below are what actually decide.
    expect(checkDriveCsvBody(CSV, null).ok).toBe(true);
  });

  // THE important case. A revoked share, a deleted file, or a link that now
  // demands sign-in all return an HTML page with HTTP 200. Parsed as CSV that
  // yields zero valid rows, which is indistinguishable from "nothing changed"
  // — so the import would silently stop working and report success forever.
  it("refuses an HTML sign-in page served with status 200", () => {
    const html = '<!DOCTYPE html><html><head><title>Sign in - Google Accounts</title>';
    const res = checkDriveCsvBody(html, "text/html; charset=utf-8");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toMatch(/not a CSV/i);
  });

  it("refuses an HTML body even when the content-type claims CSV", () => {
    const res = checkDriveCsvBody("<html><body>Sign in</body></html>", "text/csv");
    expect(res.ok).toBe(false);
  });

  it("refuses Drive's virus-scan interstitial", () => {
    const interstitial =
      "<html><head><title>Google Drive - Virus scan warning</title></head></html>";
    expect(checkDriveCsvBody(interstitial, null).ok).toBe(false);
  });

  it("refuses an empty or whitespace-only body", () => {
    expect(checkDriveCsvBody("", "text/csv").ok).toBe(false);
    expect(checkDriveCsvBody("   \n\t ", "text/csv").ok).toBe(false);
  });

  it("refuses a body over the size ceiling", () => {
    const oversized = "a".repeat(MAX_CSV_BYTES + 1);
    const res = checkDriveCsvBody(oversized, "text/csv");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toMatch(/too large/i);
  });

  it("measures the ceiling in BYTES, not characters", () => {
    // A multi-byte character must not let a body past the cap by counting
    // short. "é" is 2 bytes in UTF-8, so half the cap in these characters is
    // the whole cap in bytes.
    const halfInChars = "é".repeat(MAX_CSV_BYTES / 2 + 1);
    expect(halfInChars.length).toBeLessThan(MAX_CSV_BYTES);
    expect(checkDriveCsvBody(halfInChars, "text/csv").ok).toBe(false);
  });

  it("accepts a body exactly at the ceiling", () => {
    expect(checkDriveCsvBody("a".repeat(MAX_CSV_BYTES), "text/csv").ok).toBe(true);
  });
});
