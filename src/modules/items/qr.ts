import QRCode from "qrcode";
import { unstable_cache } from "next/cache";
import { defaultBaseUrl } from "@/lib/base-url";

export function receiptUrl(receiptNumber: string, baseUrl = defaultBaseUrl()): string {
  return `${baseUrl.replace(/\/$/, "")}/receipts/${receiptNumber}`;
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
