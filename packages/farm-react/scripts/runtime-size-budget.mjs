/** Compare core size without penalizing a smaller full compatibility runtime. */
export function assertCoreRuntimeReduction(current, reference) {
  // The caller checks the absolute core-byte budget separately. Use the larger
  // control here: shrinking the full runtime alone must not count as core growth.
  const fullRuntimePremium = Math.max(
    current.fullRuntimePremiumGzip,
    reference.fullRuntimePremiumGzip,
  );
  const reduction = (1 - current.coreRuntimePremiumGzip / fullRuntimePremium) * 100;
  if (reduction < reference.gzipReductionPercent - 1) {
    throw new Error("Core-only runtime reduction regressed against the persisted result.");
  }
}
