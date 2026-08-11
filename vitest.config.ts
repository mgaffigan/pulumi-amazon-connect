import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "pulumi-amazon-connect/jsx-dev-runtime": fileURLToPath(
        new URL("./src/view/jsx-dev-runtime.ts", import.meta.url),
      ),
      "pulumi-amazon-connect/jsx-runtime": fileURLToPath(
        new URL("./src/view/jsx-runtime.ts", import.meta.url),
      ),
      "pulumi-amazon-connect": fileURLToPath(new URL("./src/index.ts", import.meta.url)),
    },
  },
  test: {
    // The end-to-end suite talks to a real Connect instance, so it is a separate opt-in project
    // rather than part of `npm test`.
    include: ["test/**/*.test.ts", "test/**/*.test.tsx", "!test/e2e/**"],
    typecheck: {
      enabled: true,
      include: ["test/**/*.test-d.ts", "test/**/*.test-d.tsx"],
      tsconfig: "./tsconfig.json",
    },
  },
});
