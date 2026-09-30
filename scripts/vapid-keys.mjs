#!/usr/bin/env node
// Generates a Web Push VAPID key pair (P-256) and prints:
//   VAPID_PUBLIC_KEY   base64url of the uncompressed public point, goes in
//                      wrangler.jsonc "vars" (it is public).
//   VAPID_PRIVATE_JWK  the private key as JSON, goes in as a secret:
//                      wrangler secret put VAPID_PRIVATE_JWK
// Run once per deployment; rotating the keys invalidates every subscription.
import { generateKeyPairSync } from "node:crypto";

const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pub = publicKey.export({ format: "jwk" });
const priv = privateKey.export({ format: "jwk" });
const b64urlToBuf = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
const raw = Buffer.concat([Buffer.from([0x04]), b64urlToBuf(pub.x), b64urlToBuf(pub.y)]);
const b64url = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

console.log(`VAPID_PUBLIC_KEY=${b64url(raw)}`);
console.log(`VAPID_PRIVATE_JWK=${JSON.stringify({ kty: "EC", crv: "P-256", x: priv.x, y: priv.y, d: priv.d })}`);
