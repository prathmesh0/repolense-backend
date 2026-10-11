import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.js"],
    setupFiles: ["tests/helpers/setup.js"],
    // Integration tests start an in-memory MongoDB and load the embedding model
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
