import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's strip-types test runner requires the explicit extension.
import { normalizeRules, priceFor } from "./pricing.ts";

const rules = normalizeRules({
  basePerM2: 12,
  fixedOrderFee: 20,
  minOrder: 0,
  rounding: "none",
  recognize: true,
  tiers: [
    { from: 0, to: 1, price: 42 },
    { from: 1, to: 3, price: 32 },
    { from: 3, to: 5, price: 25 },
    { from: 5, to: 7, price: 20 },
    { from: 7, to: 10, price: 20 },
    { from: 10, to: 20, price: 12 },
  ],
  formats: [{ w: 5, h: 5, prices: [25, 28, 35, 47, 49, 90, 140] }],
});

function total(mode: "custom" | "standard", widthCm: number, heightCm: number, quantity: number) {
  return priceFor(rules, { mode, widthCm, heightCm, quantity }).total;
}

test("required pricing examples", () => {
  assert.equal(total("custom", 6, 5, 200), 45.2);
  assert.equal(total("standard", 5, 5, 200), 35);
  assert.equal(total("custom", 5, 5, 200), 35);
  assert.equal(total("custom", 7, 5, 1000), 138.5);
  assert.equal(total("custom", 10, 10, 2000), 396);
});

test("area keeps full precision", () => {
  assert.equal(priceFor(rules, { mode: "custom", widthCm: 5, heightCm: 5, quantity: 200 }).mqPerPiece, 0.0025);
  assert.equal(priceFor(rules, { mode: "custom", widthCm: 6, heightCm: 5, quantity: 200 }).mqPerPiece, 0.003);
});

test("floor accepts rotation and uses the immediately lower listed quantity", () => {
  const result = priceFor(rules, { mode: "custom", widthCm: 4.99, heightCm: 5, quantity: 250 });
  assert.equal(result.standardFloor, null);

  const rotated = priceFor(rules, { mode: "custom", widthCm: 6, heightCm: 5, quantity: 250 });
  assert.equal(rotated.standardFloor?.priceQuantity, 200);
  assert.equal(rotated.standardFloor?.price, 35);
});

test("custom total never drops at progressive tier boundaries", () => {
  const totals = [0.9999, 1, 1.0001, 2.9999, 3, 3.0001, 19.9999, 20, 20.0001].map((area) =>
    total("custom", area * 100, 100, 1),
  );
  for (let index = 1; index < totals.length; index += 1) {
    assert.ok(totals[index] >= totals[index - 1]);
  }
});
