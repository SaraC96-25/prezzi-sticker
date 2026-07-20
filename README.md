# Prezzi Sticker

App Shopify embedded per `wowstampa.myshopify.com` / `wowsticker.it` con:

- admin embedded per configurare regole prezzo prodotto per prodotto
- salvataggio su metafield `custom.pricing_rules` e mirror su Postgres/Supabase
- App Proxy `POST /apps/wowsticker/draft` per creare Draft Order con prezzo esatto

La base applicativa deriva dal template Shopify React Router, successore pratico del template Remix ufficiale.

## Stack

- Node 22
- Shopify App Bridge + Polaris
- React Router / Vite
- Prisma + PostgreSQL
- Render Blueprint (`render.yaml`)

## Funzioni principali

- Lista prodotti con stato `Configurato` / `Da configurare`
- Editor regole prezzo con:
  - base prezzo al mq
  - scaglioni mq
  - matrice formati standard per quantità `50,100,200,300,500,1000,2000`
  - arrotondamento, ordine minimo, limiti lato
- Simulatore live che usa la stessa logica condivisa in [app/lib/pricing.ts](/Users/sara/Documents/Playground/prezzi-sticker/app/lib/pricing.ts)
- Metafield definitions create all'install tramite `afterAuth`
- Draft Order proxy con verifica firma App Proxy Shopify

## Variabili ambiente

Usa [.env.example](/Users/sara/Documents/Playground/prezzi-sticker/.env.example) come base.

Valori da compilare:

- `SHOPIFY_API_KEY`
- `SHOPIFY_API_SECRET`
- `SCOPES=read_products,write_products,read_draft_orders,write_draft_orders`
- `SHOPIFY_APP_URL=https://<render-app>.onrender.com`
- `DATABASE_URL`:
  `postgresql://postgres.[PROJECT_REF]:[PASSWORD]@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1&sslmode=require`
- `DIRECT_URL`:
  `postgresql://postgres.[PROJECT_REF]:[PASSWORD]@aws-0-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=require`
- `SHOPIFY_APP_SESSION_SECRET`

## Shopify Partner Dashboard

1. Crea o aggiorna l'app custom per lo store `wowstampa.myshopify.com`.
2. Imposta App URL e redirect URL uguali a quelli in [shopify.app.toml](/Users/sara/Documents/Playground/prezzi-sticker/shopify.app.toml).
3. Conferma gli scope:
   `read_products,write_products,read_draft_orders,write_draft_orders`
4. Configura App Proxy:
   - prefix: `apps`
   - subpath: `wowsticker`
   - target URL: `https://<render-app>.onrender.com/proxy`

## Supabase

1. Crea un progetto Postgres.
2. Copia sia la stringa pooler (`DATABASE_URL`) sia la direct connection (`DIRECT_URL`).
3. Assicurati che entrambe usino `sslmode=require`.

## Prisma

Genera client e applica migration:

```bash
npx prisma generate
npx prisma migrate deploy
```

Le migration presenti sono in [prisma/migrations](/Users/sara/Documents/Playground/prezzi-sticker/prisma/migrations).

## Sviluppo locale

```bash
npm install
npm run dev
```

## Build

```bash
npm run typecheck
npm run build
```

## Deploy su Render

1. Crea un nuovo Web Service da questo repo GitHub.
2. Seleziona `Blueprint` oppure importa [render.yaml](/Users/sara/Documents/Playground/prezzi-sticker/render.yaml).
3. Inserisci tutte le env vars sopra.
4. Dopo il primo deploy, aggiorna `SHOPIFY_APP_URL` e gli URL in Shopify se il nome finale del servizio cambia.

## Deploy configurazione Shopify

Dopo che Render ha un URL definitivo:

```bash
shopify app deploy
```

Questo sincronizza scope, redirect e proxy.

## Note operative

- L'admin salva sul metafield `custom.pricing_rules` in formato JSON.
- L'endpoint proxy restituisce `invoice_url` quando Shopify accetta il `draftOrderCreate`.
- I dati prezzo sono mirrorati anche nella tabella `PricingRule`.
- Al webhook `app/uninstalled` vengono eliminate sessioni e mirror delle regole dal database.
