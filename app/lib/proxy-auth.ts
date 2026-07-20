import crypto from "node:crypto";

export function verifyAppProxySignature(url: URL, secret: string) {
  const provided = url.searchParams.get("signature");
  if (!provided || !secret) return false;

  const grouped = new Map<string, string[]>();

  url.searchParams.forEach((value, key) => {
    if (key === "signature") return;
    const values = grouped.get(key) ?? [];
    values.push(value);
    grouped.set(key, values);
  });

  const sorted = [...grouped.entries()]
    .map(([key, values]) => `${key}=${values.join(",")}`)
    .sort()
    .join("");

  const calculated = crypto
    .createHmac("sha256", secret)
    .update(sorted, "utf8")
    .digest("hex");

  if (provided.length !== calculated.length) {
    return false;
  }

  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(calculated));
}

export function sanitizeShopDomain(shop?: string | null) {
  if (!shop) return null;
  const trimmed = shop.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(trimmed) ? trimmed : null;
}
