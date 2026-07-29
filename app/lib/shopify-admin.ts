import type { PricingRules } from "./pricing";
import { parseRulesJson } from "./pricing";
import { buildInitialRules, normalizeMaterialKey } from "./pricing-defaults";

type AdminGraphqlClient = {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

export type ProductRecord = {
  id: string;
  title: string;
  handle: string;
  status: "ACTIVE" | "DRAFT" | "ARCHIVED" | string;
  imageUrl: string | null;
  imageAlt: string | null;
  materialKey: string;
  savedRules: PricingRules | null;
  effectiveRules: PricingRules;
  configured: boolean;
};

const PRODUCTS_QUERY = `#graphql
  query PrezziStickerProducts($first: Int!) {
    products(first: $first, sortKey: TITLE) {
      nodes {
        id
        title
        handle
        status
        featuredImage {
          url
          altText
        }
        material: metafield(namespace: "custom", key: "material") {
          value
        }
        pricingRules: metafield(namespace: "custom", key: "pricing_rules") {
          value
        }
      }
    }
  }
`;

const METAFIELDS_SET_MUTATION = `#graphql
  mutation SavePrezziStickerProduct($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        namespace
        key
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const DRAFT_ORDER_CREATE_MUTATION = `#graphql
  mutation CreatePrezziStickerDraftOrder($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder {
        id
        invoiceUrl
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const DRAFT_ORDER_AVAILABLE_DELIVERY_OPTIONS_QUERY = `#graphql
  query PrezziStickerDraftOrderRates($input: DraftOrderAvailableDeliveryOptionsInput!) {
    draftOrderAvailableDeliveryOptions(input: $input) {
      availableShippingRates {
        handle
        code
        source
        title
        price {
          amount
          currencyCode
        }
      }
      availableLocalDeliveryRates {
        handle
        code
        source
        title
        price {
          amount
          currencyCode
        }
      }
    }
  }
`;

const METAFIELD_DEFINITION_MUTATION = `#graphql
  mutation EnsureMetafieldDefinition($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition {
        id
        name
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

export async function fetchProducts(admin: AdminGraphqlClient): Promise<ProductRecord[]> {
  const payload = await adminGraphql<{ products: { nodes: any[] } }>(admin, PRODUCTS_QUERY, {
    first: 100,
  });

  return payload.products.nodes.map((product) => {
    const materialKey = normalizeMaterialKey(product.material?.value || product.handle);
    const savedRules = parseRulesJson(product.pricingRules?.value);
    const effectiveRules = buildInitialRules(materialKey, savedRules);

    return {
      id: product.id,
      title: product.title,
      handle: product.handle,
      status: product.status ?? "DRAFT",
      imageUrl: product.featuredImage?.url ?? null,
      imageAlt: product.featuredImage?.altText ?? null,
      materialKey,
      savedRules,
      effectiveRules,
      configured: Boolean(savedRules),
    };
  });
}

export async function savePricingRules(
  admin: AdminGraphqlClient,
  productId: string,
  materialKey: string,
  rules: PricingRules,
) {
  const response = await adminGraphql<{
    metafieldsSet: { userErrors: Array<{ message: string }> };
  }>(admin, METAFIELDS_SET_MUTATION, {
    metafields: [
      {
        ownerId: productId,
        namespace: "custom",
        key: "pricing_rules",
        type: "json",
        value: JSON.stringify(rules),
      },
      {
        ownerId: productId,
        namespace: "custom",
        key: "material",
        type: "single_line_text_field",
        value: materialKey,
      },
    ],
  });

  return response.metafieldsSet.userErrors ?? [];
}

export async function createDraftOrder(
  admin: AdminGraphqlClient,
  input: Record<string, unknown>,
) {
  const response = await adminGraphql<{
    draftOrderCreate: {
      draftOrder: { invoiceUrl: string } | null;
      userErrors: Array<{ message: string }>;
    };
  }>(admin, DRAFT_ORDER_CREATE_MUTATION, { input });

  return response.draftOrderCreate;
}

export async function fetchDraftOrderAvailableDeliveryOptions(
  admin: AdminGraphqlClient,
  input: Record<string, unknown>,
) {
  const response = await adminGraphql<{
    draftOrderAvailableDeliveryOptions: {
      availableShippingRates: Array<{
        handle: string;
        code: string;
        source: string;
        title: string;
        price: { amount: string; currencyCode: string };
      }>;
      availableLocalDeliveryRates: Array<{
        handle: string;
        code: string;
        source: string;
        title: string;
        price: { amount: string; currencyCode: string };
      }>;
    };
  }>(admin, DRAFT_ORDER_AVAILABLE_DELIVERY_OPTIONS_QUERY, { input });

  return response.draftOrderAvailableDeliveryOptions;
}

export async function ensureMetafieldDefinitions(admin: AdminGraphqlClient) {
  const definitions = [
    {
      name: "Pricing rules",
      namespace: "custom",
      key: "pricing_rules",
      description: "Regole di prezzo Prezzi Sticker",
      type: "json",
      ownerType: "PRODUCT",
    },
    {
      name: "Material",
      namespace: "custom",
      key: "material",
      description: "Chiave materiale Prezzi Sticker",
      type: "single_line_text_field",
      ownerType: "PRODUCT",
    },
  ];

  for (const definition of definitions) {
    const result = await adminGraphql<{
      metafieldDefinitionCreate: {
        userErrors: Array<{ code?: string; message: string }>;
      };
    }>(admin, METAFIELD_DEFINITION_MUTATION, { definition });

    const blockingErrors = (result.metafieldDefinitionCreate.userErrors ?? []).filter(
      (error) => error.code !== "TAKEN" && !/already exists/i.test(error.message),
    );

    if (blockingErrors.length) {
      throw new Error(blockingErrors.map((error) => error.message).join("; "));
    }
  }
}

export async function adminGraphql<TData>(
  admin: AdminGraphqlClient,
  query: string,
  variables?: Record<string, unknown>,
) {
  const response = await admin.graphql(query, variables ? { variables } : undefined);
  const json = (await response.json()) as {
    data?: TData;
    errors?: Array<{ message: string }>;
  };

  if (json.errors?.length) {
    throw new Error(json.errors.map((error) => error.message).join("; "));
  }

  if (!json.data) {
    throw new Error("Risposta GraphQL vuota da Shopify.");
  }

  return json.data;
}
