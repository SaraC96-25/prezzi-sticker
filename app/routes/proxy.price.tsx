import type { ActionFunctionArgs } from "react-router";
import { priceFor, type SimulationInput } from "../lib/pricing";
import { normalizeMaterialKey } from "../lib/pricing-defaults";
import { fetchProducts } from "../lib/shopify-admin";
import { sanitizeShopDomain, verifyAppProxySignature } from "../lib/proxy-auth";
import { unauthenticated } from "../shopify.server";

type PricePayload = {
  tipo?: string;
  handle?: string;
  pricing?: Partial<SimulationInput>;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const url = new URL(request.url);
  if (!verifyAppProxySignature(url, process.env.SHOPIFY_API_SECRET || "")) {
    return Response.json({ error: "Firma App Proxy non valida." }, { status: 401 });
  }

  const shop = sanitizeShopDomain(url.searchParams.get("shop"));
  if (!shop) return Response.json({ error: "Negozio non valido." }, { status: 400 });

  let payload: PricePayload;
  try {
    payload = (await request.json()) as PricePayload;
  } catch {
    return Response.json({ error: "Body JSON non valido." }, { status: 400 });
  }

  const pricing: SimulationInput = {
    mode: payload.pricing?.mode === "standard" ? "standard" : "custom",
    widthCm: Number(payload.pricing?.widthCm),
    heightCm: Number(payload.pricing?.heightCm),
    quantity: Number(payload.pricing?.quantity),
  };
  if (!(pricing.widthCm > 0) || !(pricing.heightCm > 0) || !(pricing.quantity > 0)) {
    return Response.json({ error: "Misure o quantità non valide." }, { status: 400 });
  }

  try {
    const { admin } = await unauthenticated.admin(shop);
    const products = await fetchProducts(admin);
    const materialKey = normalizeMaterialKey(payload.tipo || payload.handle);
    const product = products.find(
      (candidate) =>
        candidate.materialKey === materialKey ||
        normalizeMaterialKey(candidate.handle) === materialKey,
    );
    if (!product) return Response.json({ error: "Regole prodotto non trovate." }, { status: 404 });

    return Response.json({ price: priceFor(product.effectiveRules, pricing) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Calcolo prezzo non disponibile.";
    return Response.json({ error: message }, { status: 500 });
  }
};
