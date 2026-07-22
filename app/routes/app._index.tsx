import type { CSSProperties } from "react";
import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRouteError, isRouteErrorResponse } from "react-router";
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
  Modal,
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
  shop: {
    name: string;
    myshopifyDomain: string;
  };
  loadError: string | null;
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
  const { admin, session } = await authenticate.admin(request);

  let products: ProductRecord[] = [];
  let loadError: string | null = null;

  try {
    products = await fetchProducts(admin);
  } catch (error) {
    loadError =
      error instanceof Error
        ? error.message
        : "Impossibile caricare il catalogo prodotti da Shopify.";
  }

  return {
    products,
    shop: {
      name: session.shop,
      myshopifyDomain: session.shop,
    },
    loadError,
  } satisfies LoaderData;
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
  const { products: initialProducts, shop, loadError } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionData>();

  const [products, setProducts] = useState<ProductRecord[]>(initialProducts);
  const [search, setSearch] = useState("");
  const [statusTab, setStatusTab] = useState<"all" | "configured" | "missing">("all");
  const [catalogStatus, setCatalogStatus] = useState<"all" | "active" | "draft">("all");
  const [productPickerOpen, setProductPickerOpen] = useState(false);
  const [bulkImportOpen, setBulkImportOpen] = useState(false);
  const [bulkImportValue, setBulkImportValue] = useState("");
  const [bulkImportMessage, setBulkImportMessage] = useState<string | null>(null);
  const [tierImportOpen, setTierImportOpen] = useState(false);
  const [tierImportValue, setTierImportValue] = useState("");
  const [tierImportMessage, setTierImportMessage] = useState<string | null>(null);
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
  const [copySourceId, setCopySourceId] = useState("");
  const [copyMessage, setCopyMessage] = useState<string | null>(null);

  const selectedProduct = products.find((product) => product.id === selectedId) ?? products[0] ?? null;
  const copyableProducts = products.filter((product) => product.id !== selectedId);

  useEffect(() => {
    if (!selectedProduct) return;
    const nextRules = normalizeRules(selectedProduct.effectiveRules);
    setDraftRules(nextRules);
    setBaseline(serializeRules(nextRules));
    setCopySourceId("");
    setCopyMessage(null);
    setBulkImportMessage(null);
    setTierImportMessage(null);
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
    const matchesCatalogStatus =
      catalogStatus === "all"
        ? true
        : catalogStatus === "active"
          ? product.status === "ACTIVE"
          : product.status === "DRAFT";

    return matchesSearch && matchesStatus && matchesCatalogStatus;
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
    setCopyMessage(null);
  }

  function copyRulesFromProduct() {
    const source = copyableProducts.find((product) => product.id === copySourceId);
    if (!source) return;

    setDraftRules(normalizeRules(source.effectiveRules));
    setCopyMessage(`Configurazione copiata da ${source.title}. Ora puoi rivederla e salvare.`);
  }

  function applyBulkFormatImport() {
    const parsed = parseBulkFormatImport(bulkImportValue);
    if (!parsed.entries.length) {
      setBulkImportMessage("Nessun formato valido trovato. Controlla il testo incollato e riprova.");
      return;
    }

    const importedByKey = new Map(
      parsed.entries.map((entry) => [formatKey(entry.w, entry.h), entry.prices]),
    );

    let updatedCount = 0;
    const nextFormats = draftRules.formats.map((format) => {
      const importedPrices =
        importedByKey.get(formatKey(format.w, format.h)) ??
        importedByKey.get(formatKey(format.h, format.w));

      if (!importedPrices) return format;

      updatedCount += 1;
      return { ...format, prices: [...importedPrices] };
    });

    const missingFormats = parsed.entries
      .filter(
        (entry) =>
          !draftRules.formats.some(
            (format) =>
              formatKey(format.w, format.h) === formatKey(entry.w, entry.h) ||
              formatKey(format.w, format.h) === formatKey(entry.h, entry.w),
          ),
      )
      .map((entry) => `${entry.w}×${entry.h}`);

    if (!updatedCount) {
      setBulkImportMessage(
        "I formati incollati non corrispondono ai formati standard già presenti in questa configurazione.",
      );
      return;
    }

    setDraftRules({ ...draftRules, formats: nextFormats });
    setBulkImportMessage(
      missingFormats.length
        ? `Import completato: aggiornati ${updatedCount} formati. Nessuna corrispondenza per ${missingFormats.join(", ")}.`
        : `Import completato: aggiornati ${updatedCount} formati standard.`,
    );
    setBulkImportOpen(false);
  }

  function applyTierImport() {
    const tiers = parseTierImport(tierImportValue);
    if (!tiers.length) {
      setTierImportMessage("Nessuno scaglione valido trovato. Controlla il testo incollato e riprova.");
      return;
    }

    setDraftRules({ ...draftRules, tiers });
    setTierImportMessage(`Import completato: aggiornati ${tiers.length} scaglioni.`);
    setTierImportOpen(false);
  }

  const statusTabs = [
    { id: "all", content: "Tutti", panelID: "all-products" },
    { id: "configured", content: "Configurati", panelID: "configured-products" },
    { id: "missing", content: "Da configurare", panelID: "missing-products" },
  ];

  return (
    <Page
      title="Prezzi sticker"
      subtitle={`Catalogo collegato a ${shop.name} (${shop.myshopifyDomain}). Scegli un prodotto e imposta le sue regole di prezzo.`}
      fullWidth
    >
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
          {loadError ? (
            <Box paddingBlockEnd="400">
              <Banner tone="critical" title="Errore nel caricamento del catalogo">
                <p>{loadError}</p>
              </Banner>
            </Box>
          ) : null}

          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center" gap="400">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">
                    Prodotto selezionato
                  </Text>
                  <Text as="p" tone="subdued">
                    Apri il selettore per cercare un prodotto per titolo e filtrarlo per stato o configurazione.
                  </Text>
                </BlockStack>
                <Button onClick={() => setProductPickerOpen(true)} variant="primary">
                  Seleziona il prodotto
                </Button>
              </InlineStack>

              {selectedProduct ? (
                <InlineStack align="space-between" blockAlign="center" gap="400">
                  <InlineStack blockAlign="center" gap="300">
                    <Thumbnail
                      alt={selectedProduct.imageAlt ?? selectedProduct.title}
                      size="large"
                      source={selectedProduct.imageUrl || "https://cdn.shopify.com/static/images/empty-state.svg"}
                    />
                    <BlockStack gap="100">
                      <Text as="h3" variant="headingMd">
                        {selectedProduct.title}
                      </Text>
                      <Text as="p" tone="subdued" variant="bodyMd">
                        {summarizeRules(selectedProduct.effectiveRules)}
                      </Text>
                    </BlockStack>
                  </InlineStack>
                  <InlineStack gap="200" blockAlign="center">
                    <Badge tone={selectedProduct.status === "ACTIVE" ? "success" : undefined}>
                      {selectedProduct.status === "ACTIVE"
                        ? "Attivo"
                        : selectedProduct.status === "DRAFT"
                          ? "Bozza"
                          : selectedProduct.status}
                    </Badge>
                    <Badge tone={selectedProduct.configured ? "success" : undefined}>
                      {selectedProduct.configured ? "Configurato" : "Da configurare"}
                    </Badge>
                  </InlineStack>
                </InlineStack>
              ) : (
                <EmptyState
                  heading="Nessun prodotto disponibile"
                  image="https://cdn.shopify.com/static/images/empty-state.svg"
                >
                  <p>Il catalogo collegato a {shop.myshopifyDomain} non contiene ancora prodotti selezionabili.</p>
                </EmptyState>
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
                    <InlineGrid columns={{ xs: 1, md: "2fr auto" }} gap="300">
                      <Select
                        label="Copia configurazione da un altro prodotto"
                        onChange={(value) => setCopySourceId(value)}
                        options={[
                          { label: "Seleziona un prodotto...", value: "" },
                          ...copyableProducts.map((product) => ({
                            label: `${product.title} · ${product.materialKey}`,
                            value: product.id,
                          })),
                        ]}
                        value={copySourceId}
                      />
                      <Box paddingBlockStart="500">
                        <Button disabled={!copySourceId} onClick={copyRulesFromProduct}>
                          Copia configurazione
                        </Button>
                      </Box>
                    </InlineGrid>
                  </BlockStack>
                </Card>

                {copyMessage ? (
                  <Banner title="Configurazione copiata">
                    <p>{copyMessage}</p>
                  </Banner>
                ) : null}

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

                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="p" tone="subdued">
                        Puoi incollare una tabella scaglioni e sostituire tutti i valori in un colpo solo.
                      </Text>
                      <Button onClick={() => setTierImportOpen(true)}>Importa scaglioni</Button>
                    </InlineStack>

                    {tierImportMessage ? (
                      <Banner title="Importazione scaglioni">
                        <p>{tierImportMessage}</p>
                      </Banner>
                    ) : null}

                    <BlockStack gap="200">
                      {draftRules.tiers.map((tier, index) => (
                        <InlineGrid columns={{ xs: 1, md: "1fr 1fr 1fr auto" }} gap="300" key={index}>
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

                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="p" tone="subdued">
                        Puoi anche incollare un listino completo e aggiornare in massa i prezzi dei formati gia presenti.
                      </Text>
                      <Button onClick={() => setBulkImportOpen(true)}>Importa prezzi</Button>
                    </InlineStack>

                    {bulkImportMessage ? (
                      <Banner title="Importazione prezzi">
                        <p>{bulkImportMessage}</p>
                      </Banner>
                    ) : null}

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
                            <tr key={formatIndex}>
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
                            ? `${simBreakdown.matchedFormat.w}×${simBreakdown.matchedFormat.h} → € ${formatCurrency(simBreakdown.matchedFormatPrice ?? 0)} (formato standard)`
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

      <Modal
        onClose={() => setProductPickerOpen(false)}
        open={productPickerOpen}
        title="Seleziona il prodotto"
      >
        <Modal.Section>
          <BlockStack gap="400">
            <InlineGrid columns={{ xs: 1, md: "2fr 1fr" }} gap="400">
              <TextField
                autoComplete="off"
                label="Cerca prodotto"
                labelHidden
                onChange={setSearch}
                placeholder="Cerca per titolo o materiale..."
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

            <InlineGrid columns={{ xs: 1, md: 3 }} gap="300">
              <Select
                label="Stato catalogo"
                onChange={(value) => setCatalogStatus(value as "all" | "active" | "draft")}
                options={[
                  { label: "Tutti", value: "all" },
                  { label: "Attivi", value: "active" },
                  { label: "Bozza", value: "draft" },
                ]}
                value={catalogStatus}
              />
            </InlineGrid>

            {!filteredProducts.length ? (
              <EmptyState
                heading="Nessun prodotto trovato"
                image="https://cdn.shopify.com/static/images/empty-state.svg"
              >
                <p>Prova a cambiare ricerca o filtro di stato nel catalogo di {shop.myshopifyDomain}.</p>
              </EmptyState>
            ) : (
              <BlockStack gap="200">
                {filteredProducts.map((product) => (
                  <Card key={product.id} padding="300">
                    <InlineStack align="space-between" blockAlign="center" gap="400">
                      <InlineStack blockAlign="center" gap="300">
                        <Thumbnail
                          alt={product.imageAlt ?? product.title}
                          size="large"
                          source={product.imageUrl || "https://cdn.shopify.com/static/images/empty-state.svg"}
                        />
                        <BlockStack gap="100">
                          <Text as="h3" variant="headingMd">
                            {product.title}
                          </Text>
                          <Text as="p" tone="subdued" variant="bodyMd">
                            {summarizeRules(product.effectiveRules)}
                          </Text>
                          <InlineStack gap="200" blockAlign="center">
                            <Badge tone={product.status === "ACTIVE" ? "success" : undefined}>
                              {product.status === "ACTIVE"
                                ? "Attivo"
                                : product.status === "DRAFT"
                                  ? "Bozza"
                                  : product.status}
                            </Badge>
                            <Badge tone={product.configured ? "success" : undefined}>
                              {product.configured ? "Configurato" : "Da configurare"}
                            </Badge>
                          </InlineStack>
                        </BlockStack>
                      </InlineStack>
                      <Button
                        onClick={() => {
                          setSelectedId(product.id);
                          setProductPickerOpen(false);
                        }}
                        variant={product.id === selectedId ? "primary" : "secondary"}
                      >
                        {product.id === selectedId ? "Selezionato" : "Seleziona"}
                      </Button>
                    </InlineStack>
                  </Card>
                ))}
              </BlockStack>
            )}
          </BlockStack>
        </Modal.Section>
      </Modal>

      <Modal
        onClose={() => setBulkImportOpen(false)}
        open={bulkImportOpen}
        primaryAction={{
          content: "Importa prezzi",
          onAction: applyBulkFormatImport,
        }}
        secondaryActions={[{ content: "Annulla", onAction: () => setBulkImportOpen(false) }]}
        title="Importa prezzi formati standard"
      >
        <Modal.Section>
          <BlockStack gap="300">
            <Text as="p" tone="subdued">
              Incolla il listino con blocchi tipo <code>3x3cm</code> e righe <code>50 pezzi | 30€</code>. I prezzi vengono applicati solo ai formati gia presenti.
            </Text>
            <TextField
              autoComplete="off"
              label="Listino da incollare"
              multiline={18}
              onChange={setBulkImportValue}
              placeholder={`3x3cm\nQuantita | Prezzo\n50 pezzi | 30€\n100 pezzi | 38€`}
              value={bulkImportValue}
            />
          </BlockStack>
        </Modal.Section>
      </Modal>

      <Modal
        onClose={() => setTierImportOpen(false)}
        open={tierImportOpen}
        primaryAction={{
          content: "Importa scaglioni",
          onAction: applyTierImport,
        }}
        secondaryActions={[{ content: "Annulla", onAction: () => setTierImportOpen(false) }]}
        title="Importa sconti a scaglioni"
      >
        <Modal.Section>
          <BlockStack gap="300">
            <Text as="p" tone="subdued">
              Incolla righe tipo <code>0 - 1 mq | 126,93€/mq</code>. Gli scaglioni importati sostituiscono quelli attuali.
            </Text>
            <TextField
              autoComplete="off"
              label="Scaglioni da incollare"
              multiline={12}
              onChange={setTierImportValue}
              placeholder={`0 - 1 mq | 126,93€/mq\n1 - 3 mq | 73,26€/mq`}
              value={tierImportValue}
            />
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : "Errore inatteso nell'app Prezzi Sticker.";

  return (
    <Page title="Prezzi sticker" fullWidth>
      <Banner tone="critical" title="Application Error">
        <p>{message}</p>
      </Banner>
    </Page>
  );
}

function NumberField({
  label,
  labelHidden,
  prefix,
  value,
  onChange,
}: {
  label: string;
  labelHidden?: boolean;
  prefix?: string;
  value: number;
  onChange: (next: number) => void;
}) {
  return (
    <TextField
      autoComplete="off"
      inputMode="decimal"
      label={label}
      labelHidden={labelHidden}
      onChange={(next) => onChange(parseNumber(next))}
      prefix={prefix}
      type="text"
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

function parseBulkFormatImport(value: string) {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const entries: Array<{ w: number; h: number; prices: number[] }> = [];
  let current: { w: number; h: number; prices: number[] } | null = null;

  for (const line of lines) {
    const header = line.match(/^(\d+(?:[.,]\d+)?)\s*[xX]\s*(\d+(?:[.,]\d+)?)\s*cm$/i);
    if (header) {
      if (current) entries.push(current);
      current = {
        w: parseNumber(header[1]),
        h: parseNumber(header[2]),
        prices: QTYS.map(() => 0),
      };
      continue;
    }

    if (!current) continue;
    if (line.includes("quantita") || /^[-|]+$/.test(line.replace(/\s/g, "").toLowerCase())) continue;

    const row = line.match(/(\d+)\s*pezzi?\s*\|\s*([0-9.,]+)\s*€/i);
    if (!row) continue;

    const qty = Number(row[1]);
    const qtyIndex = QTYS.indexOf(qty as (typeof QTYS)[number]);
    if (qtyIndex < 0) continue;

    current.prices[qtyIndex] = parseNumber(row[2]);
  }

  if (current) entries.push(current);

  return {
    entries: entries.filter((entry) => entry.w > 0 && entry.h > 0),
  };
}

function parseTierImport(value: string) {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const tiers: PricingTier[] = [];

  for (const line of lines) {
    if (line.toLowerCase().includes("scaglione") || /^[-|]+$/.test(line.replace(/\s/g, ""))) continue;

    const row = line.match(
      /^(\d+(?:[.,]\d+)?)\s*-\s*(\d+(?:[.,]\d+)?)\s*mq\s*\|\s*([0-9.,]+)\s*€?\s*\/\s*mq$/i,
    );
    if (!row) continue;

    tiers.push({
      from: parseNumber(row[1]),
      to: parseNumber(row[2]),
      price: parseNumber(row[3]),
    });
  }

  return tiers.sort((left, right) => left.from - right.from);
}

function formatKey(w: number, h: number) {
  return [roundNumberKey(w), roundNumberKey(h)].sort((left, right) => left - right).join("x");
}

function roundNumberKey(value: number) {
  return Math.round(value * 100) / 100;
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
