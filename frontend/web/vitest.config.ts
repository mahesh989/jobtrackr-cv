import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Unit tests for plain, framework-free logic (data derivation, filters).
 *
 * Deliberately `node` environment and no React plugin: nothing here renders
 * components. Server Components and route files are not tested by this config —
 * they need a request context Vitest cannot provide.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
