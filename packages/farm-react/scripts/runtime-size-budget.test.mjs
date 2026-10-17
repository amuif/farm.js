import assert from "node:assert/strict";
import { test } from "node:test";
import { assertCoreRuntimeReduction } from "./runtime-size-budget.mjs";

const reference = {
  coreRuntimePremiumGzip: 100,
  fullRuntimePremiumGzip: 1000,
  gzipReductionPercent: 90,
};

test("a smaller full runtime does not falsely report core growth", () => {
  assert.doesNotThrow(() =>
    assertCoreRuntimeReduction(
      { coreRuntimePremiumGzip: 100, fullRuntimePremiumGzip: 500 },
      reference,
    ),
  );
});

test("core growth remains bounded when the full runtime shrinks", () => {
  assert.throws(() =>
    assertCoreRuntimeReduction(
      { coreRuntimePremiumGzip: 120, fullRuntimePremiumGzip: 500 },
      reference,
    ),
  );
});

test("the current full runtime remains the control when it grows", () => {
  assert.doesNotThrow(() =>
    assertCoreRuntimeReduction(
      { coreRuntimePremiumGzip: 200, fullRuntimePremiumGzip: 2000 },
      reference,
    ),
  );
  assert.throws(() =>
    assertCoreRuntimeReduction(
      { coreRuntimePremiumGzip: 230, fullRuntimePremiumGzip: 2000 },
      reference,
    ),
  );
});
