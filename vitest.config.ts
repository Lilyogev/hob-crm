import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Local tests for the server logic (no Workers runtime): `cloudflare:workers`
// resolves to a stub, and tests/d1.ts provides D1 over node:sqlite (Node 22+).
export default defineConfig({
  resolve: { alias: { "cloudflare:workers": fileURLToPath(new URL("./tests/cf-workers-stub.ts", import.meta.url)) } },
  test: { include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"], environment: "node", testTimeout: 20000 },
});
