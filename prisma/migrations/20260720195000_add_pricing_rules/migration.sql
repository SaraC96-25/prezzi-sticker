-- Add index for faster shop lookups in Shopify session storage
CREATE INDEX "Session_shop_idx" ON "Session"("shop");

-- Persist a mirrored copy of pricing rules in Postgres for admin and proxy flows
CREATE TABLE "PricingRule" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "productGid" TEXT NOT NULL,
    "materialKey" TEXT NOT NULL,
    "rulesJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PricingRule_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PricingRule_shop_productGid_key" ON "PricingRule"("shop", "productGid");
CREATE INDEX "PricingRule_shop_materialKey_idx" ON "PricingRule"("shop", "materialKey");
