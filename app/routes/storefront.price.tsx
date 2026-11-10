import { action as proxyAction } from "./proxy.price";
import { storefrontDirectAction, storefrontDirectLoader } from "../lib/storefront-direct.server";

// Endpoint diretto (senza App Proxy) per /apps/wowsticker/price. Vedi storefront-direct.server.ts.
export const loader = storefrontDirectLoader();
export const action = storefrontDirectAction("price", proxyAction, { max: 60, windowMs: 60_000 });
