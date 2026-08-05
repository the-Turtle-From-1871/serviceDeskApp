import { describe, it, expect } from "vitest";
import { signUnlockValue } from "@/lib/public-access-cookie";
import {
  RECEIPT_LINK_PARAM,
  receiptGrantCookieName,
  receiptGrantValue,
  signReceiptLinkToken,
  verifyReceiptGrantValue,
  verifyReceiptLinkToken,
} from "./receipt-link-token";

const SECRET = "test-secret";
const HR = "HR-000123";

describe("receipt link token", () => {
  it("round-trips a token for the receipt it was signed for", async () => {
    const token = await signReceiptLinkToken(HR, SECRET);
    expect(await verifyReceiptLinkToken(HR, token, SECRET)).toBe(true);
  });

  it("is URL-safe, so it needs no encoding in a link", async () => {
    const token = await signReceiptLinkToken(HR, SECRET);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(token)).toBe(token);
  });

  it("REFUSES a token minted for a different receipt", async () => {
    // The whole point of the scope: a link to one receipt must not open another.
    const token = await signReceiptLinkToken(HR, SECRET);
    expect(await verifyReceiptLinkToken("HR-000456", token, SECRET)).toBe(false);
  });

  it("refuses a tampered signature", async () => {
    const token = await signReceiptLinkToken(HR, SECRET);
    const flipped = `${token.slice(0, -1)}${token.slice(-1) === "A" ? "B" : "A"}`;
    expect(await verifyReceiptLinkToken(HR, flipped, SECRET)).toBe(false);
  });

  it("refuses a missing, empty or truncated token", async () => {
    const token = await signReceiptLinkToken(HR, SECRET);
    expect(await verifyReceiptLinkToken(HR, undefined, SECRET)).toBe(false);
    expect(await verifyReceiptLinkToken(HR, null, SECRET)).toBe(false);
    expect(await verifyReceiptLinkToken(HR, "", SECRET)).toBe(false);
    expect(await verifyReceiptLinkToken(HR, token.slice(0, -1), SECRET)).toBe(false);
  });

  it("fails CLOSED with no secret", async () => {
    const token = await signReceiptLinkToken(HR, SECRET);
    expect(await verifyReceiptLinkToken(HR, token, "")).toBe(false);
    await expect(signReceiptLinkToken(HR, "")).rejects.toThrow(/AUTH_SECRET/);
  });

  it("refuses a blank receipt number rather than signing one", async () => {
    await expect(signReceiptLinkToken("", SECRET)).rejects.toThrow(/receipt number/);
    expect(await verifyReceiptLinkToken("", "anything", SECRET)).toBe(false);
  });

  it("is domain-separated from the unlock cookie", async () => {
    // Both sign under AUTH_SECRET. Without the "rl:" prefix a value minted for
    // one purpose could be presented for the other.
    const exp = String(Date.now() + 60_000);
    const cookie = await signUnlockValue(Number(exp), SECRET);
    const sig = cookie.slice(cookie.indexOf(".") + 1);
    expect(await verifyReceiptLinkToken(exp, sig, SECRET)).toBe(false);
  });

  it("normalizes receipt numbers to uppercase so case variations verify", async () => {
    const token = await signReceiptLinkToken(HR, SECRET);
    expect(await verifyReceiptLinkToken("hr-000123", token, SECRET)).toBe(true);
    expect(await verifyReceiptLinkToken("Hr-000123", token, SECRET)).toBe(true);
  });

  it("still refuses a token for a different receipt even when case-normalized", async () => {
    const token = await signReceiptLinkToken(HR, SECRET);
    expect(await verifyReceiptLinkToken("HR-000456", token, SECRET)).toBe(false);
    expect(await verifyReceiptLinkToken("hr-000456", token, SECRET)).toBe(false);
  });
});

describe("receipt grant cookie", () => {
  it("names the __Secure- prefixed cookie in production", () => {
    expect(receiptGrantCookieName(true)).toBe("__Secure-pub_receipt");
    expect(receiptGrantCookieName(false)).toBe("pub_receipt");
  });

  it("round-trips a grant for its own receipt", async () => {
    const token = await signReceiptLinkToken(HR, SECRET);
    const value = receiptGrantValue(HR, token);
    expect(await verifyReceiptGrantValue(value, HR, SECRET)).toBe(true);
  });

  it("REFUSES a grant naming a different receipt", async () => {
    const token = await signReceiptLinkToken(HR, SECRET);
    const value = receiptGrantValue(HR, token);
    expect(await verifyReceiptGrantValue(value, "HR-000456", SECRET)).toBe(false);
  });

  it("normalizes receipt numbers so a grant verifies when the path is lowercased", async () => {
    const token = await signReceiptLinkToken(HR, SECRET);
    const value = receiptGrantValue(HR, token);
    expect(await verifyReceiptGrantValue(value, "hr-000123", SECRET)).toBe(true);
  });

  it("refuses a grant whose receipt number was swapped but signature kept", async () => {
    // The name inside the cookie is not trusted on its own — it is re-verified
    // against the signature, so rewriting it invalidates the value.
    const token = await signReceiptLinkToken(HR, SECRET);
    expect(await verifyReceiptGrantValue(`HR-000456.${token}`, "HR-000456", SECRET)).toBe(false);
  });

  it("refuses malformed and missing values", async () => {
    expect(await verifyReceiptGrantValue(undefined, HR, SECRET)).toBe(false);
    expect(await verifyReceiptGrantValue("", HR, SECRET)).toBe(false);
    expect(await verifyReceiptGrantValue("no-dot", HR, SECRET)).toBe(false);
    expect(await verifyReceiptGrantValue(`.${await signReceiptLinkToken(HR, SECRET)}`, HR, SECRET)).toBe(false);
    expect(await verifyReceiptGrantValue(`${HR}.`, HR, SECRET)).toBe(false);
  });

  it("exports the query parameter name the proxy and the link builder share", () => {
    expect(RECEIPT_LINK_PARAM).toBe("k");
  });
});
