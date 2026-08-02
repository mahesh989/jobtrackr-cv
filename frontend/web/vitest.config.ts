import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Unit tests for plain, framework-free logic (data derivation, filters).
 *
 * Default environment is `node` for plain logic tests. Component tests opt into
 * jsdom per-file with a `// @vitest-environment jsdom` docblock, so the fast
 * majority are not slowed down by a DOM.
 *
 * No @vitejs/plugin-react: Vitest's esbuild transform handles TSX directly given
 * `"jsx": "react-jsx"` in tsconfig, and the plugin's Fast Refresh is irrelevant
 * to tests. Its current major also peer-depends on a newer Vite than Vitest
 * ships, so adding it would force an unrelated upgrade.
 *
 * Server Components and route files are not tested here — they need a request
 * context Vitest cannot provide.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
