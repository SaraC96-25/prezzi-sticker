import type { ActionFunctionArgs } from "react-router";
import { applyMarketingConsent } from "../lib/marketing-consent";
import { createDraftOrder } from "../lib/shopify-admin";
import { sanitizeShopDomain, verifyAppProxySignature } from "../lib/proxy-auth";
import { unauthenticated } from "../shopify.server";

type DraftPayload = {
  currency?: string;
  customerId?: string | number | null;
  email?: string;
  phone?: string;
  shippingAddress?: {
    email?: string;
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
  shippingLine?: {
    title?: string;
    amount?: number;
  };
  acceptsMarketing?: boolean;
  marketingConsent?: {
    email?: "SUBSCRIBED" | "NOT_SUBSCRIBED" | "UNSUBSCRIBED";
    sms?: "SUBSCRIBED" | "NOT_SUBSCRIBED" | "UNSUBSCRIBED";
    whatsapp?: "SUBSCRIBED" | "NOT_SUBSCRIBED" | "UNSUBSCRIBED";
    consentUpdatedAt?: string;
    consentCollectedFrom?: string;
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

function normalizeCustomerId(value: string | number | null | undefined) {
  if (value == null || value === "") return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (raw.startsWith("gid://shopify/Customer/")) return raw;
  if (/^\d+$/.test(raw)) return `gid://shopify/Customer/${raw}`;
  return null;
}

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

  const email = (payload.email || payload.shippingAddress?.email || "").trim();
  const phone = (payload.phone || payload.shippingAddress?.phone || "").trim();
  const shippingInput = payload.shippingAddress ?? {};
  const shippingAddress = {
    firstName: (shippingInput.firstName || "").trim(),
    lastName: (shippingInput.lastName || "").trim(),
    company: (shippingInput.company || "").trim(),
    address1: (shippingInput.address1 || "").trim(),
    address2: (shippingInput.address2 || "").trim(),
    city: (shippingInput.city || "").trim(),
    provinceCode: (shippingInput.provinceCode || "").trim().toUpperCase(),
    zip: (shippingInput.zip || "").trim(),
    countryCode: (shippingInput.countryCode || "").trim().toUpperCase(),
    phone,
  };
  const hasShippingAddress = Boolean(
    shippingAddress.firstName ||
      shippingAddress.lastName ||
      shippingAddress.address1 ||
      shippingAddress.city ||
      shippingAddress.zip ||
      shippingAddress.countryCode,
  );
  const shippingAddressComplete = Boolean(
    shippingAddress.firstName &&
      shippingAddress.lastName &&
      shippingAddress.address1 &&
      shippingAddress.city &&
      shippingAddress.zip &&
      shippingAddress.countryCode &&
      (shippingAddress.countryCode !== "IT" || shippingAddress.provinceCode),
  );

  if (hasShippingAddress && !shippingAddressComplete) {
    return Response.json({ error: "Indirizzo di spedizione incompleto." }, { status: 400 });
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return Response.json({ error: "Email non valida." }, { status: 400 });
  }

  const hasShippingLine = payload.shippingLine != null;
  const shippingAmount = Number(payload.shippingLine?.amount ?? 0);
  const customerId = normalizeCustomerId(payload.customerId);
  if (hasShippingLine && (!Number.isFinite(shippingAmount) || shippingAmount < 0)) {
    return Response.json({ error: "Costo spedizione non valido." }, { status: 400 });
  }

  const shippingTitle = (payload.shippingLine?.title || "").trim() || (shippingAmount > 0 ? "Spedizione standard" : "Spedizione gratuita");

  let lineItems: Array<{
    title?: string;
    variantId?: string;
    originalUnitPriceWithCurrency?: {
      amount: string;
      currencyCode: string;
    };
    priceOverride?: {
      amount: string;
      currencyCode: string;
    };
    quantity: number;
    requiresShipping?: boolean;
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

      const customAttributes = Object.entries(item.properties ?? {}).map(([key, value]) => ({
        key,
        value: String(value ?? ""),
      }));

      return {
        title,
        originalUnitPriceWithCurrency: {
          amount: price.toFixed(2),
          currencyCode: payload.currency || "EUR",
        },
        quantity,
        requiresShipping: true,
        customAttributes,
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

    const wantsMarketing =
      payload.acceptsMarketing === true ||
      payload.marketingConsent?.email === "SUBSCRIBED" ||
      payload.marketingConsent?.sms === "SUBSCRIBED";

    const consentCustomerId = email
      ? await applyMarketingConsent(admin, {
          email,
          phone,
          firstName: shippingAddress.firstName,
          lastName: shippingAddress.lastName,
          emailState: wantsMarketing ? "SUBSCRIBED" : "NOT_SUBSCRIBED",
          smsState: wantsMarketing ? "SUBSCRIBED" : "NOT_SUBSCRIBED",
          consentUpdatedAt: payload.marketingConsent?.consentUpdatedAt,
        })
      : null;

    console.info(`${logPrefix} Creating draft order`, {
      shop,
      currencyCode: payload.currency || "EUR",
      lineItemsCount: lineItems.length,
      shippingCountryCode: shippingAddress.countryCode || "checkout",
      shippingAmount: hasShippingLine ? shippingAmount : "checkout",
    });

    const draftInput: Record<string, unknown> = {
      presentmentCurrencyCode: payload.currency || "EUR",
      purchasingEntity: customerId
        ? { customerId }
        : consentCustomerId
          ? { customerId: consentCustomerId }
          : undefined,
      lineItems,
      note: "Creato da Prezzi Sticker via App Proxy",
    };

    if (email) draftInput.email = email;
    if (phone) draftInput.phone = phone;
    if (shippingAddressComplete) {
      draftInput.shippingAddress = shippingAddress;
      draftInput.billingAddress = shippingAddress;
    }
    if (hasShippingLine) {
      draftInput.shippingLine = {
        title: shippingTitle,
        priceWithCurrency: {
          amount: shippingAmount.toFixed(2),
          currencyCode: payload.currency || "EUR",
        },
      };
    }

    const result = await createDraftOrder(admin, draftInput);

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
