// Server-only access to the Worker's Cloudflare bindings and secrets.
// `cloudflare:workers` is the runtime module that exposes the Worker env; it
// is not bundled, the runtime provides it (see vite.config.ts).
import { env } from "cloudflare:workers";
import type { D1Database, DurableObjectNamespace, R2Bucket } from "@cloudflare/workers-types";

export type AppEnv = {
  DB?: D1Database;
  STORAGE?: R2Bucket;
  // The SummaryAgent Durable Object: scheduler + the only place with egress
  // to Anthropic and Shopify (see src/server.ts).
  ROOMS?: DurableObjectNamespace;
  // Anthropic key for Hobi (chat, receipt reading). Without it Hobi is off.
  ANTHROPIC_API_KEY?: string;
  // Shopify Admin API app (client credentials). The client secret also signs
  // incoming Shopify webhooks (HMAC). See SHOPIFY.md.
  SHOPIFY_CLIENT_ID?: string;
  SHOPIFY_CLIENT_SECRET?: string;
  // Signing secret of the webhook created in Settings → Notifications (optional:
  // the client secret is also accepted).
  SHOPIFY_WEBHOOK_SECRET?: string;
  // Web Push (VAPID). Public key is a var, private key a secret.
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_JWK?: string;
  // Workers AI (Whisper) for the voice button.
  AI?: { run: (model: string, input: Record<string, unknown>) => Promise<Record<string, unknown>> };
  APP_ENV?: string;
};

export function bindings(): AppEnv {
  return env as unknown as AppEnv;
}
