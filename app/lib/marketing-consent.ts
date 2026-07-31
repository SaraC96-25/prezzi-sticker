type AdminGraphqlClient = {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

export type MarketingState = "SUBSCRIBED" | "NOT_SUBSCRIBED" | "UNSUBSCRIBED";

export type MarketingConsentInput = {
  email: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
  emailState: MarketingState;
  smsState: MarketingState;
  consentUpdatedAt?: string;
};

const CUSTOMER_SEARCH = `#graphql
  query WowFindCustomer($query: String!) {
    customers(first: 1, query: $query) {
      nodes { id }
    }
  }
`;

const CUSTOMER_CREATE = `#graphql
  mutation WowCreateCustomer($input: CustomerInput!) {
    customerCreate(input: $input) {
      customer { id }
      userErrors { field message }
    }
  }
`;

const EMAIL_CONSENT = `#graphql
  mutation WowEmailConsent($input: CustomerEmailMarketingConsentUpdateInput!) {
    customerEmailMarketingConsentUpdate(input: $input) {
      customer { id }
      userErrors { field message }
    }
  }
`;

const SMS_CONSENT = `#graphql
  mutation WowSmsConsent($input: CustomerSmsMarketingConsentUpdateInput!) {
    customerSmsMarketingConsentUpdate(input: $input) {
      customer { id }
      userErrors { field message }
    }
  }
`;

async function gql<T>(
  admin: AdminGraphqlClient,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const response = await admin.graphql(query, variables ? { variables } : undefined);
  const body = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (body.errors?.length) throw new Error(body.errors.map((entry) => entry.message).join("; "));
  if (!body.data) throw new Error("Risposta GraphQL vuota.");
  return body.data;
}

export async function findOrCreateCustomer(
  admin: AdminGraphqlClient,
  input: { email: string; phone?: string; firstName?: string; lastName?: string },
): Promise<string | null> {
  const email = input.email.trim().toLowerCase();
  if (!email) return null;

  const found = await gql<{ customers: { nodes: Array<{ id: string }> } }>(admin, CUSTOMER_SEARCH, {
    query: `email:'${email.replace(/'/g, "\\'")}'`,
  });
  const existing = found.customers?.nodes?.[0]?.id;
  if (existing) return existing;

  const created = await gql<{
    customerCreate: { customer: { id: string } | null; userErrors: Array<{ message: string }> };
  }>(admin, CUSTOMER_CREATE, {
    input: {
      email,
      phone: input.phone?.trim() || undefined,
      firstName: input.firstName?.trim() || undefined,
      lastName: input.lastName?.trim() || undefined,
    },
  });

  if (created.customerCreate.userErrors?.length) {
    const retry = await gql<{
      customerCreate: { customer: { id: string } | null; userErrors: Array<{ message: string }> };
    }>(admin, CUSTOMER_CREATE, {
      input: {
        email,
        firstName: input.firstName?.trim() || undefined,
        lastName: input.lastName?.trim() || undefined,
      },
    });
    return retry.customerCreate.customer?.id ?? null;
  }

  return created.customerCreate.customer?.id ?? null;
}

export async function applyMarketingConsent(
  admin: AdminGraphqlClient,
  input: MarketingConsentInput,
): Promise<string | null> {
  try {
    const customerId = await findOrCreateCustomer(admin, input);
    if (!customerId) return null;

    const consentUpdatedAt = input.consentUpdatedAt || new Date().toISOString();

    await gql(admin, EMAIL_CONSENT, {
      input: {
        customerId,
        emailMarketingConsent: {
          marketingState: input.emailState,
          marketingOptInLevel: "SINGLE_OPT_IN",
          consentUpdatedAt,
        },
      },
    });

    const phone = input.phone?.trim();
    if (phone) {
      await gql(admin, SMS_CONSENT, {
        input: {
          customerId,
          smsMarketingConsent: {
            marketingState: input.smsState,
            marketingOptInLevel: "SINGLE_OPT_IN",
            consentUpdatedAt,
            consentCollectedFrom: "OTHER",
          },
        },
      });
    }

    return customerId;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[marketing-consent] impossibile aggiornare il consenso", message);
    return null;
  }
}
