import type { ActionFunctionArgs } from "react-router";
import { createDraftOrder } from "../lib/shopify-admin";
import { sanitizeShopDomain, verifyAppProxySignature } from "../lib/proxy-auth";
import { unauthenticated } from "../shopify.server";

type DraftPayload = {
  currency?: string;
  items?: Array<{
    title?: string;
    price?: number;
    quantity?: number;
    tipo?: string;
    properties?: Record<string, string | number | boolean | null>;
  }>;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const url = new URL(request.url);
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const logPrefix = `[proxy.draft][${requestId}]`;

  console.info(`${logPrefix} Request received`, {
    method: request.method,
    pathname: url.pathname,
    search: url.search,
    contentType: request.headers.get("content-type"),
    userAgent: request.headers.get("user-agent"),
  });

  const signatureValid = verifyAppProxySignature(url, process.env.SHOPIFY_API_SECRET || "");
  if (!signatureValid) {
    console.warn(`${logPrefix} Invalid app proxy signature`, {
      pathname: url.pathname,
      shop: url.searchParams.get("shop"),
    });
    return Response.json({ error: "Firma App Proxy non valida." }, { status: 401 });
  }

  const shop = sanitizeShopDomain(url.searchParams.get("shop"));
  if (!shop) {
    console.warn(`${logPrefix} Missing or invalid shop parameter`, {
      rawShop: url.searchParams.get("shop"),
    });
    return Response.json({ error: "Parametro shop mancante o non valido." }, { status: 400 });
  }

  let payload: DraftPayload;

  try {
    payload = (await request.json()) as DraftPayload;
  } catch {
    console.warn(`${logPrefix} Invalid JSON body`, { shop });
    return Response.json({ error: "Body JSON non valido." }, { status: 400 });
  }

  console.info(`${logPrefix} Payload parsed`, {
    shop,
    currency: payload.currency || "EUR",
    itemsCount: Array.isArray(payload.items) ? payload.items.length : 0,
    itemsPreview: Array.isArray(payload.items)
      ? payload.items.slice(0, 3).map((item) => ({
          title: item.title,
          quantity: item.quantity,
          price: item.price,
          tipo: item.tipo,
          propertiesCount: Object.keys(item.properties ?? {}).length,
        }))
      : [],
  });

  if (!Array.isArray(payload.items) || !payload.items.length) {
    console.warn(`${logPrefix} Empty items payload`, { shop });
    return Response.json({ error: "Nessun item da trasformare in Draft Order." }, { status: 400 });
  }

  let lineItems: Array<{
    title: string;
    originalUnitPrice: number;
    quantity: number;
    customAttributes: Array<{ key: string; value: string }>;
  }>;

  try {
    lineItems = payload.items.map((item, index) => {
      const title = item.title?.trim();
      const price = Number(item.price ?? 0);
      const quantity = Math.max(1, Math.round(Number(item.quantity ?? 1)));

      if (!title || !Number.isFinite(price) || price < 0) {
        throw new Error(`L'item ${index + 1} ha titolo o prezzo non valido.`);
      }

      return {
        title,
        originalUnitPrice: price,
        quantity,
        customAttributes: Object.entries(item.properties ?? {}).map(([key, value]) => ({
          key,
          value: String(value ?? ""),
        })),
      };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Line item non valido.";
    console.warn(`${logPrefix} Invalid line items`, {
      shop,
      error: message,
    });
    return Response.json({ error: message }, { status: 400 });
  }

  try {
    const { admin } = await unauthenticated.admin(shop);
    console.info(`${logPrefix} Creating draft order`, {
      shop,
      currencyCode: payload.currency || "EUR",
      lineItemsCount: lineItems.length,
    });

    const result = await createDraftOrder(admin, {
      presentmentCurrencyCode: payload.currency || "EUR",
      lineItems,
      note: "Creato da Prezzi Sticker via App Proxy",
    });

    if (result.userErrors?.length || !result.draftOrder?.invoiceUrl) {
      console.warn(`${logPrefix} Draft order rejected`, {
        shop,
        userErrors: result.userErrors?.map((entry) => entry.message) ?? [],
        hasInvoiceUrl: Boolean(result.draftOrder?.invoiceUrl),
      });
      return Response.json(
        {
          error:
            result.userErrors?.map((entry) => entry.message).join("; ") ||
            "Shopify non ha restituito invoice_url.",
        },
        { status: 422 },
      );
    }

    console.info(`${logPrefix} Draft order created`, {
      shop,
      invoiceUrl: result.draftOrder.invoiceUrl,
    });
    return Response.json({ invoice_url: result.draftOrder.invoiceUrl });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Errore interno durante il Draft Order.";
    console.error(`${logPrefix} Draft order exception`, {
      shop,
      error: message,
    });
    return Response.json({ error: message }, { status: 500 });
  }
};
