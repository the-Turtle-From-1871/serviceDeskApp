import QRCode from "qrcode";
import { unstable_cache } from "next/cache";
import { defaultBaseUrl } from "@/lib/base-url";
import { RECEIPT_LINK_PARAM, signReceiptLinkToken } from "@/lib/receipt-link-token";

export function receiptUrl(receiptNumber: string, baseUrl = defaultBaseUrl()): string {
  return `${baseUrl.replace(/\/$/, "")}/receipts/${receiptNumber}`;
}

/**
 * The receipt URL we SEND — `receiptUrl` plus a signed token that lets a
 * logged-out recipient past the public-access PIN gate for this one receipt.
 * Use it for every link we generate for a specific receipt (the notification
 * emails, the QR on the DA 2062); use bare `receiptUrl` for anything DISPLAYED,
 * which should stay short and typable.
 *
 * Never throws. A missing AUTH_SECRET yields the plain URL, so a misconfigured
 * deploy costs the recipient a PIN prompt rather than failing the email send or
 * the PDF render outright.
 */
export async function receiptLinkUrl(receiptNumber: string, baseUrl?: string): Promise<string> {
  const url = receiptUrl(receiptNumber, baseUrl);
  try {
    const token = await signReceiptLinkToken(receiptNumber, process.env.AUTH_SECRET ?? "");
    // base64url — URL-safe by construction, so it needs no encoding.
    return `${url}?${RECEIPT_LINK_PARAM}=${token}`;
  } catch (e) {
    console.error("[receipt-link] could not sign a receipt link token; sending the plain URL:", e);
    return url;
  }
}

export function itemUrl(itemId: string, baseUrl = defaultBaseUrl()): string {
  return `${baseUrl.replace(/\/$/, "")}/i/${itemId}`;
}

// The QR for a given URL never changes, yet it was re-encoded (CPU-bound PNG work)
// on every item-page view, QR page, and PDF/label render. Cache it across requests
// AND deploys, keyed on the resolved URL — so a base-url change yields a fresh code
// while the same id reuses the encoded image. revalidate:false = never expires,
// which is correct because the key captures every input.
const cachedQrDataUrl = unstable_cache(
  (url: string) => QRCode.toDataURL(url, { margin: 1, width: 320 }),
  ["item-qr-v1"],
  { revalidate: false },
);

export function itemQrDataUrl(itemId: string, baseUrl?: string): Promise<string> {
  return cachedQrDataUrl(itemUrl(itemId, baseUrl));
}
