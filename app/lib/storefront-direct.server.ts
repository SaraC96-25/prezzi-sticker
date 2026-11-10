import crypto from "node:crypto";
import type { ActionFunctionArgs } from "react-router";
import { sanitizeShopDomain } from "./proxy-auth";

/**
 * Chiamate dirette dallo storefront al backend, senza passare dall'App Proxy.
 *
 * L'edge Cloudflare di Shopify può rispondere 429 + challenge ("Just a moment...")
 * alle fetch verso /apps/*, e la richiesta non arriva mai qui. Questi endpoint
 * accettano richieste solo dalle origini dello store, applicano un rate limit
 * per IP e poi inoltrano alla stessa action proxy, firmando la richiesta lato
 * server come farebbe Shopify. Tutta la validazione e il calcolo prezzi
 * restano quelli delle route proxy.*.
 *
 * Il frontend deve usare POST con `Content-Type: text/plain` (body JSON come
 * stringa) e nessun header custom: così è una "simple request" CORS e il
 * browser non manda il preflight OPTIONS.
 */

const DEFAULT_ORIGINS = "https://wowsticker.it,https://www.wowsticker.it";

function allowedOrigins() {
  return (process.env.STOREFRONT_ORIGINS || DEFAULT_ORIGINS)
    .split(",")
    .map((value) => value.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

function corsHeaders(origin: string | null) {
  const headers = new Headers({ Vary: "Origin" });
  if (origin && allowedOrigins().includes(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type");
    headers.set("Access-Control-Max-Age", "600");
  }
  return headers;
}

function withCors(response: Response, origin: string | null) {
  const headers = new Headers(response.headers);
  corsHeaders(origin).forEach((value, key) => headers.set(key, value));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

function rateLimited(key: string, limit: number, windowMs: number) {
  const now = Date.now();
  if (buckets.size > 5000) {
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  }
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }
  bucket.count += 1;
  return bucket.count > limit;
}

function clientIp(request: Request) {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

function signProxyParams(params: URLSearchParams, secret: string) {
  const grouped = new Map<string, string[]>();
  params.forEach((value, key) => {
    if (key === "signature") return;
    grouped.set(key, [...(grouped.get(key) ?? []), value]);
  });
  const sorted = [...grouped.entries()]
    .map(([key, values]) => `${key}=${values.join(",")}`)
    .sort()
    .join("");
  return crypto.createHmac("sha256", secret).update(sorted, "utf8").digest("hex");
}

type ProxyAction = (args: ActionFunctionArgs) => Promise<Response>;

export function storefrontDirectAction(
  name: string,
  proxyAction: ProxyAction,
  limit: { max: number; windowMs: number },
) {
  return async (args: ActionFunctionArgs) => {
    const { request } = args;
    const origin = request.headers.get("origin")?.replace(/\/$/, "") ?? null;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "POST") {
      return withCors(Response.json({ error: "Metodo non consentito." }, { status: 405 }), origin);
    }
    if (!origin || !allowedOrigins().includes(origin)) {
      console.warn(`[storefront.${name}] Origin non consentita`, { origin });
      return Response.json({ error: "Origine non consentita." }, { status: 403 });
    }

    if (rateLimited(`${name}:${clientIp(request)}`, limit.max, limit.windowMs)) {
      return withCors(
        Response.json(
          { error: "Troppe richieste, riprova tra qualche secondo." },
          { status: 429, headers: { "Retry-After": String(Math.ceil(limit.windowMs / 1000)) } },
        ),
        origin,
      );
    }

    const shop = sanitizeShopDomain(process.env.STOREFRONT_SHOP);
    const secret = process.env.SHOPIFY_API_SECRET || "";
    if (!shop || !secret) {
      console.error(`[storefront.${name}] STOREFRONT_SHOP o SHOPIFY_API_SECRET mancanti`);
      return withCors(Response.json({ error: "Configurazione mancante." }, { status: 500 }), origin);
    }

    const params = new URLSearchParams({
      shop,
      path_prefix: "/apps/wowsticker",
      timestamp: String(Math.floor(Date.now() / 1000)),
    });
    params.set("signature", signProxyParams(params, secret));

    const target = new URL(request.url);
    target.pathname = `/proxy/${name}`;
    target.search = params.toString();

    const forwarded = new Request(target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": request.headers.get("user-agent") ?? "",
      },
      body: await request.text(),
    });

    const response = await proxyAction({ ...args, request: forwarded });
    return withCors(response, origin);
  };
}

export function storefrontDirectLoader() {
  return async ({ request }: { request: Request }) => {
    const origin = request.headers.get("origin")?.replace(/\/$/, "") ?? null;
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    return withCors(Response.json({ error: "Usa POST." }, { status: 405 }), origin);
  };
}
