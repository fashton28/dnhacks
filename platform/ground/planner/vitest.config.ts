import { defineConfig } from 'vitest/config';

// cli.test.ts spawns the built CLI per test and parity.test.ts spawns the
// Python oracle once per file. Both are well under the defaults on an idle
// box, but when the companion, UI and planner suites run side by side the
// default 5 s / 10 s budgets can lapse and vitest then SKIPS the parity
// tests rather than failing them. The budgets below are wall-clock slack
// only; no assertion is relaxed.
export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
