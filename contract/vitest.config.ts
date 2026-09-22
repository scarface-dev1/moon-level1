import { defineConfig } from "vitest/config";

export default defineConfig({
  mode: "node",
  test: {
    deps: {
      interopDefault: true
    },
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    root: ".",
    reporters: ["default"],
    testTimeout: 30_000
  },
  resolve: {
    extensions: [".ts", ".js"],
    conditions: ["import", "node", "default"]
  }
});
