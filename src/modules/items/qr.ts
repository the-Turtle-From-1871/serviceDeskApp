import QRCode from "qrcode";

export function itemUrl(itemId: string, baseUrl = process.env.APP_URL ?? ""): string {
  return `${baseUrl.replace(/\/$/, "")}/i/${itemId}`;
}

export function itemQrDataUrl(itemId: string, baseUrl?: string): Promise<string> {
  return QRCode.toDataURL(itemUrl(itemId, baseUrl), { margin: 1, width: 320 });
}
