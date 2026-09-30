// Stand-in for the Workers runtime module in local tests: bindings.server.ts
// reads its env from here, and each test installs a fresh in-memory DB.
export const env: Record<string, unknown> = {};
