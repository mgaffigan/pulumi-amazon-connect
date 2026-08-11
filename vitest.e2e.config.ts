import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * The end-to-end suite: publishes flows to a real Amazon Connect instance and deletes them again.
 *
 * Run with `CONNECT_E2E_INSTANCE_ID=<sandbox-instance-id> npm run test:e2e`. Without that variable
 * every test skips, so the command is safe to run anywhere.
 */
export default defineConfig({
  resolve: {
    alias: {
      "pulumi-amazon-connect/jsx-dev-runtime": fileURLToPath(
        new URL("./src/view/jsx-dev-runtime.ts", import.meta.url),
      ),
      "pulumi-amazon-connect/jsx-runtime": fileURLToPath(
        new URL("./src/view/jsx-runtime.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["test/e2e/**/*.e2e.test.ts", "test/e2e/**/*.e2e.test.tsx"],
    // One flow at a time: these share an instance and a naming prefix.
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 120_000,
  },
});
