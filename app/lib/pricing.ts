export const QTYS = [50, 100, 200, 300, 500, 1000, 2000] as const;

export type SupportedQty = (typeof QTYS)[number];
export type RoundingMode = "none" | "0.10" | "0.50" | "1";

export type PricingTier = {
  from: number;
  to: number;
  price: number;
};

export type PricingFormat = {
  w: number;
  h: number;
  prices: number[];
};

export type PricingRules = {
  basePerM2: number;
  minOrder: number;
  rounding: RoundingMode;
  recognize: boolean;
  tiers: PricingTier[];
  formats: PricingFormat[];
  minSideCm?: number;
  maxSideCm?: number;
};

export type SimulationMode = "custom" | "standard";

export type SimulationInput = {
  mode: SimulationMode;
  widthCm: number;
  heightCm: number;
  quantity: number;
};

export type PricingBreakdown = {
  mqPerPiece: number;
  totalMq: number;
  appliedRate: number;
  subtotal: number;
  roundedTotal: number;
  total: number;
  matchedFormat: PricingFormat | null;
  matchedFormatPrice: number | null;
  tier: PricingTier | null;
};

export const EMPTY_RULES: PricingRules = {
  basePerM2: 0,
  minOrder: 19,
  rounding: "0.10",
  recognize: true,
  tiers: [],
  formats: [],
  minSideCm: 1,
  maxSideCm: 300,
};

export function roundDecimal(value: number, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export function clampNonNegative(value: number) {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function normalizeRules(input?: Partial<PricingRules> | null): PricingRules {
  return {
    basePerM2: roundDecimal(clampNonNegative(Number(input?.basePerM2 ?? EMPTY_RULES.basePerM2))),
    minOrder: roundDecimal(clampNonNegative(Number(input?.minOrder ?? EMPTY_RULES.minOrder))),
    rounding: normalizeRounding(input?.rounding),
    recognize: input?.recognize ?? EMPTY_RULES.recognize,
    tiers: (input?.tiers ?? [])
      .map((tier) => ({
        from: roundDecimal(clampNonNegative(Number(tier.from))),
        to: roundDecimal(clampNonNegative(Number(tier.to))),
        price: roundDecimal(clampNonNegative(Number(tier.price))),
      }))
      .sort((left, right) => left.from - right.from),
    formats: (input?.formats ?? [])
      .map((format) => ({
        w: roundDecimal(clampNonNegative(Number(format.w))),
        h: roundDecimal(clampNonNegative(Number(format.h))),
        prices: QTYS.map((_, index) =>
          roundDecimal(clampNonNegative(Number(format.prices?.[index] ?? 0))),
        ),
      }))
      .filter((format) => format.w > 0 && format.h > 0),
    minSideCm: roundDecimal(clampNonNegative(Number(input?.minSideCm ?? EMPTY_RULES.minSideCm))),
    maxSideCm: roundDecimal(clampNonNegative(Number(input?.maxSideCm ?? EMPTY_RULES.maxSideCm))),
  };
}

export function normalizeRounding(value: unknown): RoundingMode {
  if (value === "0.10" || value === "0.50" || value === "1" || value === "none") {
    return value;
  }

  return EMPTY_RULES.rounding;
}

export function serializeRules(rules: PricingRules) {
  return JSON.stringify(normalizeRules(rules));
}

export function parseRulesJson(value?: string | null) {
  if (!value) return null;

  try {
    return normalizeRules(JSON.parse(value) as PricingRules);
  } catch {
    return null;
  }
}

export function matchFormat(
  formats: PricingFormat[],
  widthCm: number,
  heightCm: number,
) {
  return (
    formats.find(
      (format) =>
        (sameNumber(format.w, widthCm) && sameNumber(format.h, heightCm)) ||
        (sameNumber(format.w, heightCm) && sameNumber(format.h, widthCm)),
    ) ?? null
  );
}

export function formatLot(format: PricingFormat | null, quantity: number) {
  if (!format) return null;
  const index = QTYS.indexOf(quantity as SupportedQty);
  if (index < 0) return null;
  return roundDecimal(clampNonNegative(format.prices[index] ?? 0));
}

export function tierRate(tiers: PricingTier[], totalMq: number) {
  return (
    tiers.find((tier) => totalMq >= tier.from && totalMq <= tier.to) ?? null
  );
}

export function ratePerM2(rules: PricingRules, totalMq: number) {
  return tierRate(rules.tiers, totalMq)?.price ?? rules.basePerM2;
}

export function roundTotal(total: number, rounding: RoundingMode) {
  if (rounding === "none") return roundDecimal(total);

  const step = Number(rounding);
  if (!Number.isFinite(step) || step <= 0) return roundDecimal(total);

  return roundDecimal(Math.ceil(total / step - 1e-9) * step);
}

export function priceCustom(
  rules: PricingRules,
  widthCm: number,
  heightCm: number,
  quantity: number,
): PricingBreakdown {
  const mqPerPiece = roundDecimal((widthCm * heightCm) / 10000, 4);
  const totalMq = roundDecimal(mqPerPiece * quantity, 4);
  const tier = tierRate(rules.tiers, totalMq);
  const appliedRate = tier?.price ?? rules.basePerM2;
  const subtotal = roundDecimal(appliedRate * totalMq);
  const roundedTotal = roundTotal(Math.max(subtotal, rules.minOrder), rules.rounding);

  return {
    mqPerPiece,
    totalMq,
    appliedRate: roundDecimal(appliedRate),
    subtotal,
    roundedTotal,
    total: roundedTotal,
    matchedFormat: null,
    matchedFormatPrice: null,
    tier,
  };
}

export function priceFor(
  rules: PricingRules,
  input: SimulationInput,
): PricingBreakdown {
  const normalized = normalizeRules(rules);
  const widthCm = roundDecimal(clampNonNegative(input.widthCm));
  const heightCm = roundDecimal(clampNonNegative(input.heightCm));
  const quantity = Math.max(0, Math.round(input.quantity));

  if (input.mode === "standard") {
    const standard = matchFormat(normalized.formats, widthCm, heightCm);
    const standardPrice = formatLot(standard, quantity);
    const subtotal = standardPrice ?? 0;
    const roundedTotal = roundTotal(
      Math.max(subtotal, normalized.minOrder),
      normalized.rounding,
    );

    return {
      mqPerPiece: roundDecimal((widthCm * heightCm) / 10000, 4),
      totalMq: roundDecimal(((widthCm * heightCm) / 10000) * quantity, 4),
      appliedRate: standardPrice ?? 0,
      subtotal,
      roundedTotal,
      total: roundedTotal,
      matchedFormat: standard,
      matchedFormatPrice: standardPrice,
      tier: null,
    };
  }

  if (normalized.recognize) {
    const matched = matchFormat(normalized.formats, widthCm, heightCm);
    const matchedPrice = formatLot(matched, quantity);
    if (matched && matchedPrice !== null) {
      const roundedTotal = roundTotal(
        Math.max(matchedPrice, normalized.minOrder),
        normalized.rounding,
      );

      return {
        mqPerPiece: roundDecimal((widthCm * heightCm) / 10000, 4),
        totalMq: roundDecimal(((widthCm * heightCm) / 10000) * quantity, 4),
        appliedRate: matchedPrice,
        subtotal: matchedPrice,
        roundedTotal,
        total: roundedTotal,
        matchedFormat: matched,
        matchedFormatPrice: matchedPrice,
        tier: null,
      };
    }
  }

  return priceCustom(normalized, widthCm, heightCm, quantity);
}

export function summarizeRules(rules: PricingRules) {
  const normalized = normalizeRules(rules);
  return `Base €${formatCurrency(normalized.basePerM2)}/mq · ${normalized.tiers.length} scaglioni · ${normalized.formats.length} formati standard`;
}

export function formatCurrency(value: number) {
  return roundDecimal(value).toFixed(2).replace(".", ",");
}

export function analyzeTierRanges(tiers: PricingTier[]) {
  const normalized = [...tiers].sort((left, right) => left.from - right.from);
  const errors: string[] = [];
  const warnings: string[] = [];

  normalized.forEach((tier, index) => {
    if (tier.to < tier.from) {
      errors.push(`Lo scaglione ${index + 1} ha un intervallo non valido.`);
    }

    const previous = normalized[index - 1];
    if (!previous) return;

    if (tier.from < previous.to) {
      errors.push(`Gli scaglioni ${index} e ${index + 1} si sovrappongono.`);
      return;
    }

    const gap = roundDecimal(tier.from - previous.to, 2);
    if (gap > 0.02) {
      warnings.push(`C'è un buco tra ${previous.to} mq e ${tier.from} mq.`);
    }
  });

  return { errors, warnings };
}

function sameNumber(left: number, right: number) {
  return Math.abs(left - right) < 0.001;
}
