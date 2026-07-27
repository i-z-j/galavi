import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Default: pure node. DOM-dependent tests (overlays) opt into jsdom via a
    // `// @vitest-environment jsdom` docblock at the top of the test file.
    environment: "node",
    include    : ["tests/**/*.test.ts"],
  },
});
