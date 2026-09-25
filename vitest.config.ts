import { configDefaults, defineConfig } from "vitest/config";

const integrationEnabled = process.env.RUN_INTEGRATION_TESTS === "1";

export default defineConfig({
  test: {
    // The integration suite talks to a real network (see test/integration/).
    // It is gated behind RUN_INTEGRATION_TESTS=1 so the default `npm test` —
    // and therefore CI — stays offline and fast.
    //
    // `configDefaults.exclude` is spread back in deliberately: assigning
    // `exclude` replaces vitest's defaults rather than extending them, and
    // dropping `**/node_modules/**` would make the runner collect specs out
    // of installed packages.
    exclude: [
      ...configDefaults.exclude,
      ...(integrationEnabled ? [] : ["**/test/integration/**"]),
    ],
    // Confirmed writes wait for a ledger close, which is ~5s on testnet.
    testTimeout: integrationEnabled ? 300_000 : 5_000,
    hookTimeout: integrationEnabled ? 300_000 : 10_000,
  },
});
