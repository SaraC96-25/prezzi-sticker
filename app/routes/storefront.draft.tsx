import { action as proxyAction } from "./proxy.draft";
import { storefrontDirectAction, storefrontDirectLoader } from "../lib/storefront-direct.server";

// Endpoint diretto (senza App Proxy) per /apps/wowsticker/draft. Vedi storefront-direct.server.ts.
export const loader = storefrontDirectLoader();
export const action = storefrontDirectAction("draft", proxyAction, { max: 10, windowMs: 60_000 });
