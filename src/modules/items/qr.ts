import QRCode from "qrcode";

// The QR code encodes an absolute URL so a phone can open it. Prefer the
// explicitly configured APP_URL; fall back to Vercel's injected domain envs so
// codes are still scannable before APP_URL is set.
function defaultBaseUrl(): string {
  if (process.env.APP_URL) return process.env.APP_URL;
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL;
  return vercel ? `https://${vercel}` : "";
}

export function itemUrl(itemId: string, baseUrl = defaultBaseUrl()): string {
  return `${baseUrl.replace(/\/$/, "")}/i/${itemId}`;
}

export function itemQrDataUrl(itemId: string, baseUrl?: string): Promise<string> {
  return QRCode.toDataURL(itemUrl(itemId, baseUrl), { margin: 1, width: 320 });
}
