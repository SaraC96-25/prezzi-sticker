import type { ActionFunctionArgs } from "react-router";
import { fetchDraftOrderAvailableDeliveryOptions } from "../lib/shopify-admin";
import { sanitizeShopDomain, verifyAppProxySignature } from "../lib/proxy-auth";
import { unauthenticated } from "../shopify.server";

type RatesPayload = {
  currency?: string;
  shippingAddress?: {
    firstName?: string;
    lastName?: string;
    company?: string;
    address1?: string;
    address2?: string;
    city?: string;
    provinceCode?: string;
    zip?: string;
    countryCode?: string;
    phone?: string;
  };
  items?: Array<{
    title?: string;
    price?: number;
    quantity?: number;
    tipo?: string;
    handle?: string;
    variantId?: string | number | null;
    properties?: Record<string, string | number | boolean | null>;
  }>;
};

function normalizeVariantId(value: string | number | null | undefined) {
  if (value == null || value === "") return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (raw.startsWith("gid://shopify/ProductVariant/")) return raw;
  if (/^\d+$/.test(raw)) return `gid://shopify/ProductVariant/${raw}`;
  return null;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const url = new URL(request.url);
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const logPrefix = `[proxy.rates][${requestId}]`;

  const signatureValid = verifyAppProxySignature(url, process.env.SHOPIFY_API_SECRET || "");
  if (!signatureValid) {
    return Response.json({ error: "Firma App Proxy non valida." }, { status: 401 });
  }

  const shop = sanitizeShopDomain(url.searchParams.get("shop"));
  if (!shop) {
    return Response.json({ error: "Parametro shop mancante o non valido." }, { status: 400 });
  }

  let payload: RatesPayload;
  try {
    payload = (await request.json()) as RatesPayload;
  } catch {
    return Response.json({ error: "Body JSON non valido." }, { status: 400 });
  }

  if (!Array.isArray(payload.items) || !payload.items.length) {
    return Response.json({ error: "Nessun item per il calcolo spedizione." }, { status: 400 });
  }

  const shippingInput = payload.shippingAddress ?? {};
  const shippingAddress = {
    firstName: (shippingInput.firstName || "").trim() || undefined,
    lastName: (shippingInput.lastName || "").trim() || undefined,
    company: (shippingInput.company || "").trim() || undefined,
    address1: (shippingInput.address1 || "").trim(),
    address2: (shippingInput.address2 || "").trim() || undefined,
    city: (shippingInput.city || "").trim(),
    provinceCode: (shippingInput.provinceCode || "").trim().toUpperCase() || undefined,
    zip: (shippingInput.zip || "").trim(),
    countryCode: (shippingInput.countryCode || "").trim().toUpperCase(),
    phone: (shippingInput.phone || "").trim() || undefined,
  };

  if (!shippingAddress.address1 || !shippingAddress.city || !shippingAddress.zip || !shippingAddress.countryCode) {
    return Response.json({ error: "Indirizzo di spedizione incompleto." }, { status: 400 });
  }

  try {
    const lineItems = payload.items.map((item, index) => {
      const title = (item.title || "").trim();
      const price = Number(item.price ?? 0);
      const quantity = Math.max(1, Math.round(Number(item.quantity ?? 1)));
      const variantId = normalizeVariantId(item.variantId);

      if (!Number.isFinite(price) || price < 0) {
        throw new Error(`Prezzo non valido per l'item ${index + 1}.`);
      }

      const customAttributes = Object.entries(item.properties ?? {}).map(([key, value]) => ({
        key,
        value: String(value ?? ""),
      }));

      if (variantId) {
        return {
          variantId,
          quantity,
          priceOverride: {
            amount: price.toFixed(2),
            currencyCode: payload.currency || "EUR",
          },
          customAttributes,
        };
      }

      if (!title) {
        throw new Error(`Titolo mancante per l'item ${index + 1}.`);
      }

      return {
        title,
        quantity,
        requiresShipping: true,
        originalUnitPriceWithCurrency: {
          amount: price.toFixed(2),
          currencyCode: payload.currency || "EUR",
        },
        customAttributes,
      };
    });

    const { admin } = await unauthenticated.admin(shop);
    const deliveryOptions = await fetchDraftOrderAvailableDeliveryOptions(admin, {
      lineItems,
      shippingAddress,
      marketRegionCountryCode: shippingAddress.countryCode,
    });

    const rates = [
      ...(deliveryOptions.availableShippingRates ?? []),
      ...(deliveryOptions.availableLocalDeliveryRates ?? []),
    ].map((rate) => ({
      handle: rate.handle,
      code: rate.code,
      source: rate.source,
      title: rate.title,
      price: Number(rate.price.amount),
      currency: rate.price.currencyCode,
    }));

    console.info(`${logPrefix} Rates calculated`, {
      shop,
      ratesCount: rates.length,
      countryCode: shippingAddress.countryCode,
      firstRate: rates[0]?.title ?? null,
    });

    return Response.json({ rates });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Errore interno nel calcolo spedizione.";
    console.error(`${logPrefix} Rates exception`, { shop, error: message });
    return Response.json({ error: message }, { status: 500 });
  }
};
