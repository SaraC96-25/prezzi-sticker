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

  if (!verifyAppProxySignature(url, process.env.SHOPIFY_API_SECRET || "")) {
    return Response.json({ error: "Firma App Proxy non valida." }, { status: 401 });
  }

  const shop = sanitizeShopDomain(url.searchParams.get("shop"));
  if (!shop) {
    return Response.json({ error: "Parametro shop mancante o non valido." }, { status: 400 });
  }

  let payload: DraftPayload;

  try {
    payload = (await request.json()) as DraftPayload;
  } catch {
    return Response.json({ error: "Body JSON non valido." }, { status: 400 });
  }

  if (!Array.isArray(payload.items) || !payload.items.length) {
    return Response.json({ error: "Nessun item da trasformare in Draft Order." }, { status: 400 });
  }

  const lineItems = payload.items.map((item, index) => {
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

  try {
    const { admin } = await unauthenticated.admin(shop);
    const result = await createDraftOrder(admin, {
      currencyCode: payload.currency || "EUR",
      lineItems,
      note: "Creato da Prezzi Sticker via App Proxy",
    });

    if (result.userErrors?.length || !result.draftOrder?.invoiceUrl) {
      return Response.json(
        {
          error:
            result.userErrors?.map((entry) => entry.message).join("; ") ||
            "Shopify non ha restituito invoice_url.",
        },
        { status: 422 },
      );
    }

    return Response.json({ invoice_url: result.draftOrder.invoiceUrl });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Errore interno durante il Draft Order.";
    return Response.json({ error: message }, { status: 500 });
  }
};
