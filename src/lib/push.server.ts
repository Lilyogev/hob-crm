// Web Push without a library: an empty push (no payload, so no encryption)
// signed with VAPID (ES256 via WebCrypto). The content waits in push_outbox
// and the service worker pulls it. Sent from the DO (the only place with
// egress to Google's and Apple's push servers).
//
// Keys: VAPID_PUBLIC_KEY is a plain var (wrangler.jsonc), VAPID_PRIVATE_JWK a
// secret. Generate a pair with `node scripts/vapid-keys.mjs`.
import type { D1Database } from "@cloudflare/workers-types";

const DEFAULT_SUBJECT = "mailto:hob@example.com";

export type PushEnv = { DB?: D1Database; VAPID_PRIVATE_JWK?: string; VAPID_PUBLIC_KEY?: string };

const b64url = (bytes: ArrayBuffer | Uint8Array): string => {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (const b of u8) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const b64urlText = (text: string): string => b64url(new TextEncoder().encode(text));

async function vapidAuth(endpoint: string, jwkJson: string, publicKey: string, subject: string): Promise<string> {
  const jwk = JSON.parse(jwkJson) as JsonWebKey;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const aud = new URL(endpoint).origin;
  const unsigned = `${b64urlText(JSON.stringify({ typ: "JWT", alg: "ES256" }))}.${b64urlText(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }))}`;
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(unsigned));
  return `vapid t=${unsigned}.${b64url(sig)}, k=${publicKey}`;
}

/** The VAPID subject (mailto:), from settings.push_subject or the placeholder. */
async function pushSubject(db: D1Database): Promise<string> {
  try {
    const row = await db.prepare("SELECT value FROM settings WHERE key = 'push_subject'").first<{ value: string }>();
    const v = (row?.value ?? "").trim();
    return /^mailto:[^\s@]+@[^\s@]+$/.test(v) ? v : DEFAULT_SUBJECT;
  } catch {
    return DEFAULT_SUBJECT;
  }
}

/** Records a notification and pushes it to every registered device. Never throws. */
export async function pushNotify(env: PushEnv, title: string, body: string, url = "/?tab=hobi"): Promise<{ sent: number; failed: number }> {
  const out = { sent: 0, failed: 0 };
  if (!env.DB) return out;
  try {
    await env.DB.prepare("INSERT INTO push_outbox (title, body, url) VALUES (?, ?, ?)").bind(title.slice(0, 80), body.slice(0, 300), url).run();
    await env.DB.prepare("DELETE FROM push_outbox WHERE id NOT IN (SELECT id FROM push_outbox ORDER BY id DESC LIMIT 30)").run();
    if (!env.VAPID_PRIVATE_JWK || !env.VAPID_PUBLIC_KEY) return out;
    const subject = await pushSubject(env.DB);
    const subs = await env.DB.prepare("SELECT endpoint FROM push_subs").all<{ endpoint: string }>();
    for (const sub of subs.results ?? []) {
      try {
        const res = await fetch(sub.endpoint, {
          method: "POST",
          headers: { Authorization: await vapidAuth(sub.endpoint, env.VAPID_PRIVATE_JWK, env.VAPID_PUBLIC_KEY, subject), TTL: "86400", Urgency: "high", "Content-Length": "0" },
        });
        if (res.status === 404 || res.status === 410) {
          await env.DB.prepare("DELETE FROM push_subs WHERE endpoint = ?").bind(sub.endpoint).run();
          out.failed++;
        } else if (res.ok) {
          await env.DB.prepare("UPDATE push_subs SET last_ok_at = datetime('now') WHERE endpoint = ?").bind(sub.endpoint).run();
          out.sent++;
        } else {
          console.error("push failed", res.status, (await res.text()).slice(0, 200));
          out.failed++;
        }
      } catch (error) {
        console.error("push error", String(error));
        out.failed++;
      }
    }
  } catch (error) {
    console.error("pushNotify failed", String(error));
  }
  return out;
}
