import {
  EMPTY_RULES,
  normalizeRules,
  type PricingRules,
} from "./pricing";

export const MATERIAL_KEYS = [
  "vinile",
  "trasparente",
  "olografico",
  "prespaziato",
  "magnetico",
  "dtf",
  "oro",
  "stampataglio",
  "mezzotaglio",
  "etichette",
  "maxi",
  "parete",
  "calpestabile",
] as const;

export type MaterialKey = (typeof MATERIAL_KEYS)[number];

const seededDefaults: Partial<Record<MaterialKey, PricingRules>> = {
  vinile: normalizeRules({
    basePerM2: 14,
    minOrder: 19,
    rounding: "0.10",
    recognize: true,
    tiers: [
      { from: 5, to: 9.99, price: 14 },
      { from: 10, to: 20, price: 12 },
      { from: 20, to: 50, price: 10 },
    ],
    formats: [
      { w: 3, h: 3, prices: [19, 23, 29, 35, 40, 59, 90] },
      { w: 5, h: 5, prices: [25, 28, 35, 47, 49, 90, 140] },
      { w: 7, h: 5, prices: [28, 39, 45, 44, 89, 140, 210] },
      { w: 7, h: 7, prices: [36, 43, 68, 80, 120, 180, 270] },
      { w: 10, h: 7, prices: [39, 49, 84, 105, 140, 210, 290] },
      { w: 10, h: 10, prices: [45, 45, 98, 126, 167, 280, 390] },
    ],
  }),
  prespaziato: normalizeRules({
    basePerM2: 16,
    minOrder: 19,
    rounding: "0.10",
    recognize: true,
    tiers: [
      { from: 10, to: 14.99, price: 16 },
      { from: 15, to: 20, price: 14 },
      { from: 22, to: 30, price: 12 },
    ],
    formats: [
      { w: 7, h: 7, prices: [47, 69, 88, 104, 156, 234, 351] },
      { w: 10, h: 7, prices: [51, 75, 109, 137, 182, 273, 377] },
      { w: 10, h: 10, prices: [59, 85, 127, 164, 217, 364, 507] },
      { w: 12, h: 12, prices: [90, 143, 194, 247, 281, 429, 546] },
    ],
  }),
  magnetico: normalizeRules({
    basePerM2: 22,
    minOrder: 25,
    rounding: "0.10",
    recognize: true,
    tiers: [{ from: 10, to: 20, price: 20 }],
    formats: [
      { w: 5, h: 5, prices: [34, 38, 47, 66, 77, 122, 189] },
      { w: 7, h: 5, prices: [38, 53, 61, 85, 120, 189, 284] },
      { w: 10, h: 7, prices: [53, 78, 113, 142, 189, 284, 392] },
    ],
  }),
};

export const DEFAULT_RULES = seededDefaults;

export function normalizeMaterialKey(value?: string | null) {
  if (!value) return "";
  return value.trim().toLowerCase().replace(/\s+/g, "");
}

export function getSeededRules(materialKey?: string | null) {
  const normalized = normalizeMaterialKey(materialKey) as MaterialKey;
  const seeded = DEFAULT_RULES[normalized];
  return seeded ? normalizeRules(seeded) : null;
}

export function buildInitialRules(materialKey?: string | null, savedRules?: PricingRules | null) {
  if (savedRules) return normalizeRules(savedRules);
  return getSeededRules(materialKey) ?? normalizeRules(EMPTY_RULES);
}
