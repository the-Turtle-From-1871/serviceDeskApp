import QRCode from "qrcode";
import { defaultBaseUrl } from "@/lib/base-url";

export function receiptUrl(receiptNumber: string, baseUrl = defaultBaseUrl()): string {
  return `${baseUrl.replace(/\/$/, "")}/receipts/${receiptNumber}`;
}

export function itemUrl(itemId: string, baseUrl = defaultBaseUrl()): string {
  return `${baseUrl.replace(/\/$/, "")}/i/${itemId}`;
}

export function itemQrDataUrl(itemId: string, baseUrl?: string): Promise<string> {
  return QRCode.toDataURL(itemUrl(itemId, baseUrl), { margin: 1, width: 320 });
}
