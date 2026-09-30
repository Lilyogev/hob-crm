import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

// One build stamp shared by the server and client bundles. The client and SSR
// builds each reload this config module, but both run in the same process, so
// the stamp is anchored on process.env and minted once per build. /api/board
// echoes the server's stamp; the client reloads when its own differs, so after
// a deploy nobody keeps working on a stale tab.
const BUILD_ID = (process.env.__HOB_BUILD_STAMP ||= Date.now().toString(36));

export default defineConfig(() => ({
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  // The server bundle runs as a Cloudflare Worker: there is no node_modules at
  // runtime, so every npm dependency is bundled in. `cloudflare:workers` is a
  // runtime built-in and stays external.
  ssr: { noExternal: true as const, external: ["cloudflare:workers"] },
  build: { rollupOptions: { external: [/^cloudflare:/] } },
  // The Worker entry must export only the fetch handler and the Durable
  // Object class. With code splitting, Rollup turns server.js into a shared
  // chunk that re-exports internal helpers, and workerd refuses to start
  // ("not of type function or ExportedHandler"). One file for the SSR bundle.
  environments: {
    ssr: { build: { rollupOptions: { output: { inlineDynamicImports: true } } } },
  },
  plugins: [
    // TanStack Start must run before React's plugin. The build emits
    // dist/server/server.js (Workers-shaped, `export default { fetch }`) plus
    // dist/client (hashed static assets served by the ASSETS binding).
    tanstackStart({ server: { entry: "server" } }),
    react(),
    tailwindcss(),
    tsconfigPaths(),
  ],
}));
