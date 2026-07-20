import type { CSSProperties } from "react";
import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { SaveBar } from "@shopify/app-bridge-react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Divider,
  EmptyState,
  InlineGrid,
  InlineStack,
  Layout,
  Page,
  Select,
  Tabs,
  Text,
  TextField,
  Thumbnail,
} from "@shopify/polaris";
import db from "../db.server";
import {
  fetchProducts,
  savePricingRules,
  type ProductRecord,
} from "../lib/shopify-admin";
import {
  EMPTY_RULES,
  QTYS,
  analyzeTierRanges,
  formatCurrency,
  normalizeRules,
  priceFor,
  serializeRules,
  summarizeRules,
  type PricingFormat,
  type PricingRules,
  type PricingTier,
  type SimulationMode,
} from "../lib/pricing";
import { authenticate } from "../shopify.server";

type LoaderData = {
  products: ProductRecord[];
};

type ActionData =
  | {
      ok: true;
      product: ProductRecord;
    }
  | {
      ok: false;
      errors: string[];
    };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const products = await fetchProducts(admin);

  return { products } satisfies LoaderData;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();

  if (formData.get("intent") !== "save") {
    return Response.json({ ok: false, errors: ["Intent non supportato."] } satisfies ActionData, {
      status: 400,
    });
  }

  const productId = String(formData.get("productId") ?? "");
  const materialKey = String(formData.get("materialKey") ?? "");
  const rulesPayload = String(formData.get("rules") ?? "");

  if (!productId || !materialKey || !rulesPayload) {
    return Response.json(
      { ok: false, errors: ["Dati di salvataggio incompleti."] } satisfies ActionData,
      { status: 400 },
    );
  }

  let rules: PricingRules;

  try {
    rules = normalizeRules(JSON.parse(rulesPayload) as PricingRules);
  } catch {
    return Response.json(
      { ok: false, errors: ["Le regole prezzo non sono in formato JSON valido."] } satisfies ActionData,
      { status: 400 },
    );
  }

  const metafieldErrors = await savePricingRules(admin, productId, materialKey, rules);
  if (metafieldErrors.length) {
    return Response.json(
      {
        ok: false,
        errors: metafieldErrors.map((error) => error.message),
      } satisfies ActionData,
      { status: 400 },
    );
  }

  await db.pricingRule.upsert({
    where: {
      shop_productGid: {
        shop: session.shop,
        productGid: productId,
      },
    },
    update: {
      materialKey,
      rulesJson: rules as any,
    },
    create: {
      shop: session.shop,
      productGid: productId,
      materialKey,
      rulesJson: rules as any,
    },
  });

  const refreshed = await fetchProducts(admin);
  const updated = refreshed.find((product) => product.id === productId);

  if (!updated) {
    return Response.json(
      { ok: false, errors: ["Prodotto non trovato dopo il salvataggio."] } satisfies ActionData,
      { status: 500 },
    );
  }

  return Response.json({ ok: true, product: updated } satisfies ActionData);
};

export default function AppIndex() {
  const { products: initialProducts } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionData>();

  const [products, setProducts] = useState<ProductRecord[]>(initialProducts);
  const [search, setSearch] = useState("");
  const [statusTab, setStatusTab] = useState<"all" | "configured" | "missing">("all");
  const [selectedId, setSelectedId] = useState(initialProducts[0]?.id ?? "");
  const [draftRules, setDraftRules] = useState<PricingRules>(
    initialProducts[0]?.effectiveRules ?? EMPTY_RULES,
  );
  const [baseline, setBaseline] = useState(
    serializeRules(initialProducts[0]?.effectiveRules ?? EMPTY_RULES),
  );
  const [simMode, setSimMode] = useState<SimulationMode>("custom");
  const [simWidth, setSimWidth] = useState("10");
  const [simHeight, setSimHeight] = useState("15");
  const [simQty, setSimQty] = useState("300");

  const selectedProduct = products.find((product) => product.id === selectedId) ?? products[0] ?? null;

  useEffect(() => {
    if (!selectedProduct) return;
    const nextRules = normalizeRules(selectedProduct.effectiveRules);
    setDraftRules(nextRules);
    setBaseline(serializeRules(nextRules));
  }, [selectedId, selectedProduct?.id]);

  useEffect(() => {
    if (!fetcher.data || !fetcher.data.ok) return;
    const updatedProduct = fetcher.data.product;

    setProducts((current) =>
      current.map((product) =>
        product.id === updatedProduct.id ? updatedProduct : product,
      ),
    );

    setDraftRules(normalizeRules(updatedProduct.effectiveRules));
    setBaseline(serializeRules(updatedProduct.effectiveRules));
  }, [fetcher.data]);

  const filteredProducts = products.filter((product) => {
    const text = `${product.title} ${product.materialKey} ${product.handle}`.toLowerCase();
    const matchesSearch = !search.trim() || text.includes(search.trim().toLowerCase());
    const matchesStatus =
      statusTab === "all"
        ? true
        : statusTab === "configured"
          ? product.configured
          : !product.configured;

    return matchesSearch && matchesStatus;
  });

  const dirty = selectedProduct ? serializeRules(draftRules) !== baseline : false;
  const validation = analyzeTierRanges(draftRules.tiers);
  const simBreakdown = priceFor(draftRules, {
    mode: simMode,
    widthCm: Number(simWidth || 0),
    heightCm: Number(simHeight || 0),
    quantity: Number(simQty || 0),
  });
  const savePending = fetcher.state !== "idle";

  function saveCurrentProduct() {
    if (!selectedProduct) return;

    const formData = new FormData();
    formData.set("intent", "save");
    formData.set("productId", selectedProduct.id);
    formData.set("materialKey", selectedProduct.materialKey);
    formData.set("rules", serializeRules(draftRules));
    fetcher.submit(formData, { method: "post" });
  }

  function resetDraft() {
    if (!selectedProduct) return;
    const restored = normalizeRules(selectedProduct.effectiveRules);
    setDraftRules(restored);
    setBaseline(serializeRules(restored));
  }

  const statusTabs = [
    { id: "all", content: "Tutti", panelID: "all-products" },
    { id: "configured", content: "Configurati", panelID: "configured-products" },
    { id: "missing", content: "Da configurare", panelID: "missing-products" },
  ];

  return (
    <Page title="Prezzi sticker" subtitle="Scegli un prodotto e imposta le sue regole di prezzo." fullWidth>
      <SaveBar open={dirty}>
        <button disabled={savePending} onClick={resetDraft} type="button">
          Annulla
        </button>
        <button
          disabled={savePending || Boolean(validation.errors.length)}
          loading={savePending ? true : undefined}
          onClick={saveCurrentProduct}
          type="button"
          variant="primary"
        >
          Salva
        </button>
      </SaveBar>

      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineGrid columns={{ xs: 1, md: "2fr 1fr" }} gap="400">
                <TextField
                  autoComplete="off"
                  label="Cerca prodotto"
                  labelHidden
                  onChange={setSearch}
                  placeholder="Cerca un prodotto..."
                  value={search}
                />
                <Tabs
                  onSelect={(index) => {
                    const next = statusTabs[index]?.id as "all" | "configured" | "missing";
                    setStatusTab(next ?? "all");
                  }}
                  selected={statusTabs.findIndex((tab) => tab.id === statusTab)}
                  tabs={statusTabs}
                />
              </InlineGrid>

              {!filteredProducts.length ? (
                <EmptyState
                  heading="Nessun prodotto trovato"
                  image="https://cdn.shopify.com/static/images/empty-state.svg"
                >
                  <p>Prova a cambiare ricerca o filtro di stato.</p>
                </EmptyState>
              ) : (
                <BlockStack gap="0">
                  {filteredProducts.map((product, index) => (
                    <button
                      key={product.id}
                      onClick={() => setSelectedId(product.id)}
                      style={{
                        appearance: "none",
                        background:
                          product.id === selectedId
                            ? "var(--p-color-bg-surface-secondary)"
                            : "var(--p-color-bg-surface)",
                        border:
                          index === 0
                            ? "1px solid var(--p-color-border)"
                            : "0 solid var(--p-color-border)",
                        borderBottom: "1px solid var(--p-color-border)",
                        borderRadius: index === 0 ? 12 : 0,
                        cursor: "pointer",
                        padding: 16,
                        textAlign: "left",
                        width: "100%",
                      }}
                    >
                      <InlineStack align="space-between" blockAlign="center" gap="400">
                        <InlineStack blockAlign="center" gap="300">
                          <Thumbnail
                            alt={product.imageAlt ?? product.title}
                            size="large"
                            source={product.imageUrl ?? ""}
                          />
                          <BlockStack gap="100">
                            <Text as="h3" variant="headingMd">
                              {product.title}
                            </Text>
                            <Text as="p" tone="subdued" variant="bodyMd">
                              {summarizeRules(product.effectiveRules)}
                            </Text>
                          </BlockStack>
                        </InlineStack>
                        <Badge tone={product.configured ? "success" : undefined}>
                          {product.configured ? "Configurato" : "Da configurare"}
                        </Badge>
                      </InlineStack>
                    </button>
                  ))}
                </BlockStack>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {selectedProduct ? (
          <>
            <Layout.Section>
              <BlockStack gap="400">
                <Card>
                  <BlockStack gap="200">
                    <InlineStack align="space-between" blockAlign="center">
                      <BlockStack gap="100">
                        <Text as="h2" variant="headingLg">
                          {selectedProduct.title}
                        </Text>
                        <Text as="p" tone="subdued">
                          Regole di prezzo per il prodotto · Chiave materiale <code>{selectedProduct.materialKey}</code>
                        </Text>
                      </BlockStack>
                      <Badge tone={selectedProduct.configured ? "success" : undefined}>
                        {selectedProduct.configured ? "Configurato" : "Da configurare"}
                      </Badge>
                    </InlineStack>
                  </BlockStack>
                </Card>

                {fetcher.data && !fetcher.data.ok ? (
                  <Banner tone="critical" title="Salvataggio non riuscito">
                    <ul>
                      {fetcher.data.errors.map((error) => (
                        <li key={error}>{error}</li>
                      ))}
                    </ul>
                  </Banner>
                ) : null}

                {validation.errors.length ? (
                  <Banner tone="critical" title="Ci sono errori negli scaglioni">
                    <ul>
                      {validation.errors.map((error) => (
                        <li key={error}>{error}</li>
                      ))}
                    </ul>
                  </Banner>
                ) : null}

                {validation.warnings.length ? (
                  <Banner tone="warning" title="Controlla i buchi tra gli scaglioni">
                    <ul>
                      {validation.warnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  </Banner>
                ) : null}

                <Card>
                  <BlockStack gap="300">
                    <Text as="h3" variant="headingMd">
                      Prezzo base al mq
                    </Text>
                    <Text as="p" tone="subdued">
                      Usato per le misure personalizzate quando nessuno scaglione è applicabile.
                    </Text>
                    <InlineGrid columns={{ xs: 1, md: 2 }} gap="300">
                      <NumberField
                        label="Prezzo al mq"
                        prefix="€"
                        step={0.1}
                        value={draftRules.basePerM2}
                        onChange={(value) => setDraftRules({ ...draftRules, basePerM2: value })}
                      />
                    </InlineGrid>
                  </BlockStack>
                </Card>

                <Card>
                  <BlockStack gap="300">
                    <InlineStack align="space-between" blockAlign="center">
                      <BlockStack gap="100">
                        <Text as="h3" variant="headingMd">
                          Sconti a scaglioni
                        </Text>
                        <Text as="p" tone="subdued">
                          Gli scaglioni si applicano ai mq totali dell'ordine.
                        </Text>
                      </BlockStack>
                      <Button onClick={() => setDraftRules({ ...draftRules, tiers: [...draftRules.tiers, { from: 0, to: 0, price: draftRules.basePerM2 }] })}>
                        Aggiungi scaglione
                      </Button>
                    </InlineStack>

                    <BlockStack gap="200">
                      {draftRules.tiers.map((tier, index) => (
                        <InlineGrid columns={{ xs: 1, md: "1fr 1fr 1fr auto" }} gap="300" key={`${index}-${tier.from}-${tier.to}`}>
                          <NumberField
                            label="Da (mq)"
                            value={tier.from}
                            onChange={(value) => updateTier(index, "from", value, draftRules, setDraftRules)}
                          />
                          <NumberField
                            label="A (mq)"
                            value={tier.to}
                            onChange={(value) => updateTier(index, "to", value, draftRules, setDraftRules)}
                          />
                          <NumberField
                            label="Prezzo al mq"
                            prefix="€"
                            value={tier.price}
                            onChange={(value) => updateTier(index, "price", value, draftRules, setDraftRules)}
                          />
                          <Box paddingBlockStart="600">
                                <Button tone="critical" onClick={() => removeTier(index, draftRules, setDraftRules)}>
                                  Elimina
                                </Button>
                          </Box>
                        </InlineGrid>
                      ))}
                    </BlockStack>
                  </BlockStack>
                </Card>

                <Card>
                  <BlockStack gap="300">
                    <InlineStack align="space-between" blockAlign="center">
                      <BlockStack gap="100">
                        <Text as="h3" variant="headingMd">
                          Formati standard
                        </Text>
                        <Text as="p" tone="subdued">
                          Inserisci il prezzo totale del lotto per ogni quantità; il prezzo al pezzo è calcolato in automatico.
                        </Text>
                      </BlockStack>
                      <Button
                        onClick={() =>
                          setDraftRules({
                            ...draftRules,
                            formats: [
                              ...draftRules.formats,
                              { w: 5, h: 5, prices: QTYS.map(() => 0) },
                            ],
                          })
                        }
                      >
                        Aggiungi formato
                      </Button>
                    </InlineStack>

                    <Box borderRadius="200" borderWidth="025" overflowX="scroll">
                      <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 980 }}>
                        <thead>
                          <tr>
                            <th style={tableHeadStyle}>Formato</th>
                            {QTYS.map((qty) => (
                              <th key={qty} style={tableHeadStyle}>
                                {qty} pezzi
                              </th>
                            ))}
                            <th style={tableHeadStyle}></th>
                          </tr>
                        </thead>
                        <tbody>
                          {draftRules.formats.map((format, formatIndex) => (
                            <tr key={`${formatIndex}-${format.w}-${format.h}`}>
                              <td style={tableCellStyle}>
                                <InlineGrid columns={3} gap="200">
                                  <NumberField
                                    label="Larghezza"
                                    labelHidden
                                    value={format.w}
                                    onChange={(value) =>
                                      updateFormatDimension(
                                        formatIndex,
                                        "w",
                                        value,
                                        draftRules,
                                        setDraftRules,
                                      )
                                    }
                                  />
                                  <NumberField
                                    label="Altezza"
                                    labelHidden
                                    value={format.h}
                                    onChange={(value) =>
                                      updateFormatDimension(
                                        formatIndex,
                                        "h",
                                        value,
                                        draftRules,
                                        setDraftRules,
                                      )
                                    }
                                  />
                                  <Box paddingBlockStart="200">
                                    <Text as="span" tone="subdued">
                                      cm
                                    </Text>
                                  </Box>
                                </InlineGrid>
                              </td>
                              {QTYS.map((qty, qtyIndex) => {
                                const price = format.prices[qtyIndex] ?? 0;
                                return (
                                  <td key={qty} style={tableCellStyle}>
                                    <BlockStack gap="100">
                                      <NumberField
                                        label={`${qty} pezzi`}
                                        labelHidden
                                        prefix="€"
                                        value={price}
                                        onChange={(value) =>
                                          updateFormatPrice(
                                            formatIndex,
                                            qtyIndex,
                                            value,
                                            draftRules,
                                            setDraftRules,
                                          )
                                        }
                                      />
                                      <Text as="span" tone="subdued" variant="bodySm">
                                        € {formatCurrency(qty ? price / qty : 0)}/pz
                                      </Text>
                                    </BlockStack>
                                  </td>
                                );
                              })}
                              <td style={tableCellStyle}>
                                <Button
                                  tone="critical"
                                  onClick={() => removeFormat(formatIndex, draftRules, setDraftRules)}
                                >
                                  Elimina
                                </Button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </Box>

                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="span">Riconosci i formati standard nelle misure personalizzate</Text>
                      <Button
                        onClick={() => setDraftRules({ ...draftRules, recognize: !draftRules.recognize })}
                        variant={draftRules.recognize ? "primary" : "secondary"}
                      >
                        {draftRules.recognize ? "Attivo" : "Disattivato"}
                      </Button>
                    </InlineStack>
                  </BlockStack>
                </Card>

                <Card>
                  <BlockStack gap="300">
                    <Text as="h3" variant="headingMd">
                      Regole finali
                    </Text>
                    <InlineGrid columns={{ xs: 1, md: 2 }} gap="300">
                      <Select
                        label="Arrotondamento del totale"
                        onChange={(value) =>
                          setDraftRules({
                            ...draftRules,
                            rounding: value as PricingRules["rounding"],
                          })
                        }
                        options={[
                          { label: "Nessuno", value: "none" },
                          { label: "Ai 10 centesimi superiori", value: "0.10" },
                          { label: "Ai 50 centesimi superiori", value: "0.50" },
                          { label: "All'euro superiore", value: "1" },
                        ]}
                        value={draftRules.rounding}
                      />
                      <NumberField
                        label="Ordine minimo"
                        prefix="€"
                        value={draftRules.minOrder}
                        onChange={(value) => setDraftRules({ ...draftRules, minOrder: value })}
                      />
                      <NumberField
                        label="Min per lato (cm)"
                        value={draftRules.minSideCm ?? 1}
                        onChange={(value) => setDraftRules({ ...draftRules, minSideCm: value })}
                      />
                      <NumberField
                        label="Max per lato (cm)"
                        value={draftRules.maxSideCm ?? 300}
                        onChange={(value) => setDraftRules({ ...draftRules, maxSideCm: value })}
                      />
                    </InlineGrid>
                  </BlockStack>
                </Card>
              </BlockStack>
            </Layout.Section>

            <Layout.Section variant="oneThird">
              <Box position="sticky" insetBlockStart="400">
                <Card>
                  <BlockStack gap="300">
                    <Text as="h3" variant="headingMd">
                      Prova il prezzo
                    </Text>
                    <Tabs
                      onSelect={(index) => setSimMode(index === 0 ? "custom" : "standard")}
                      selected={simMode === "custom" ? 0 : 1}
                      tabs={[
                        { id: "custom", content: "Su misura", panelID: "custom-pricing" },
                        { id: "standard", content: "Formato standard", panelID: "standard-pricing" },
                      ]}
                    />
                    <InlineGrid columns={2} gap="300">
                      <TextField label="Base (cm)" autoComplete="off" value={simWidth} onChange={setSimWidth} />
                      <TextField label="Altezza (cm)" autoComplete="off" value={simHeight} onChange={setSimHeight} />
                    </InlineGrid>
                    <TextField label="Quantità" autoComplete="off" value={simQty} onChange={setSimQty} />

                    <Divider />

                    <BlockStack gap="150">
                      <MetricRow label="mq a pezzo" value={formatMetric(simBreakdown.mqPerPiece)} />
                      <MetricRow label="mq totali" value={`${formatMetric(simBreakdown.totalMq)} mq`} />
                      <MetricRow
                        label="scaglione applicato"
                        value={
                          simBreakdown.matchedFormat
                            ? `${simBreakdown.matchedFormat.w}×${simBreakdown.matchedFormat.h} → € ${formatCurrency(simBreakdown.matchedFormatPrice ?? 0)}`
                            : simBreakdown.tier
                              ? `${simBreakdown.tier.from}-${simBreakdown.tier.to} mq → € ${formatCurrency(simBreakdown.appliedRate)}/mq`
                              : `Base € ${formatCurrency(simBreakdown.appliedRate)}/mq`
                        }
                      />
                      <MetricRow label="subtotal" value={`€ ${formatCurrency(simBreakdown.subtotal)}`} />
                    </BlockStack>

                    <Divider />

                    <BlockStack gap="100">
                      <Text as="p" variant="headingXl">
                        € {formatCurrency(simBreakdown.total)}
                      </Text>
                      <Text as="p" tone="subdued" variant="bodySm">
                        Il simulatore riflette le regole impostate in questa pagina.
                      </Text>
                    </BlockStack>
                  </BlockStack>
                </Card>
              </Box>
            </Layout.Section>
          </>
        ) : null}
      </Layout>
    </Page>
  );
}

function NumberField({
  label,
  labelHidden,
  prefix,
  step,
  value,
  onChange,
}: {
  label: string;
  labelHidden?: boolean;
  prefix?: string;
  step?: number;
  value: number;
  onChange: (next: number) => void;
}) {
  return (
    <TextField
      autoComplete="off"
      label={label}
      labelHidden={labelHidden}
      onChange={(next) => onChange(parseNumber(next))}
      prefix={prefix}
      step={step}
      type="number"
      value={String(value)}
    />
  );
}

function MetricRow({ label, value }: { label: string; value: string }) {
  return (
    <InlineStack align="space-between">
      <Text as="span" tone="subdued" variant="bodySm">
        {label}
      </Text>
      <Text as="span" variant="bodyMd">
        {value}
      </Text>
    </InlineStack>
  );
}

function updateTier(
  index: number,
  key: keyof PricingTier,
  value: number,
  rules: PricingRules,
  setRules: (rules: PricingRules) => void,
) {
  const tiers = [...rules.tiers];
  tiers[index] = { ...tiers[index], [key]: value };
  setRules({ ...rules, tiers });
}

function removeTier(index: number, rules: PricingRules, setRules: (rules: PricingRules) => void) {
  setRules({
    ...rules,
    tiers: rules.tiers.filter((_, tierIndex) => tierIndex !== index),
  });
}

function updateFormatDimension(
  index: number,
  key: "w" | "h",
  value: number,
  rules: PricingRules,
  setRules: (rules: PricingRules) => void,
) {
  const formats = [...rules.formats];
  formats[index] = { ...formats[index], [key]: value };
  setRules({ ...rules, formats });
}

function updateFormatPrice(
  formatIndex: number,
  priceIndex: number,
  value: number,
  rules: PricingRules,
  setRules: (rules: PricingRules) => void,
) {
  const formats = [...rules.formats];
  const prices = [...formats[formatIndex].prices];
  prices[priceIndex] = value;
  formats[formatIndex] = { ...formats[formatIndex], prices };
  setRules({ ...rules, formats });
}

function removeFormat(index: number, rules: PricingRules, setRules: (rules: PricingRules) => void) {
  setRules({
    ...rules,
    formats: rules.formats.filter((_, formatIndex) => formatIndex !== index),
  });
}

function parseNumber(value: string) {
  const normalized = value.replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatMetric(value: number) {
  return value.toFixed(value < 1 ? 3 : 2).replace(".", ",");
}

const tableHeadStyle: CSSProperties = {
  borderBottom: "1px solid var(--p-color-border)",
  fontSize: 12,
  padding: "12px",
  textAlign: "left",
};

const tableCellStyle: CSSProperties = {
  borderBottom: "1px solid var(--p-color-border)",
  padding: "12px",
  verticalAlign: "top",
};
