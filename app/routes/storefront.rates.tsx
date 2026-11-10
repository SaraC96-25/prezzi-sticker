import { action as proxyAction } from "./proxy.rates";
import { storefrontDirectAction, storefrontDirectLoader } from "../lib/storefront-direct.server";

// Endpoint diretto (senza App Proxy) per /apps/wowsticker/rates. Vedi storefront-direct.server.ts.
export const loader = storefrontDirectLoader();
export const action = storefrontDirectAction("rates", proxyAction, { max: 30, windowMs: 60_000 });
