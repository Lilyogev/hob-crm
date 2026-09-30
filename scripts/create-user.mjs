#!/usr/bin/env node
// Prints the SQL that creates (or replaces) a board user with a salted
// PBKDF2-SHA256 hash, in the exact format hashPassword() in
// src/lib/hob.server.ts produces. It never touches the database itself:
//
//   node scripts/create-user.mjs avia "אביה" 'the-password' > /tmp/user.sql
//   wrangler d1 execute hob-crm-db --remote --file=/tmp/user.sql
//
// Never commit the output, never put it in a migration.
import { pbkdf2Sync, randomBytes } from "node:crypto";

const [key, name, password] = process.argv.slice(2);
if (!key || !name || !password) {
  console.error('usage: node scripts/create-user.mjs <avia|lior> "<display name>" \'<password>\'');
  process.exit(1);
}
if (!["avia", "lior"].includes(key)) {
  console.error("key must be avia or lior (see src/lib/partners.ts)");
  process.exit(1);
}
if (password.length < 8) {
  console.error("password: at least 8 characters");
  process.exit(1);
}

const ITERATIONS = 100_000;
const salt = randomBytes(16);
const hash = pbkdf2Sync(password, salt, ITERATIONS, 32, "sha256");
const stored = `pbkdf2-sha256$${ITERATIONS}$${salt.toString("hex")}$${hash.toString("hex")}`;
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

process.stdout.write(
  `INSERT OR REPLACE INTO users (id, key, name, pass_hash, active, created_at)\n` +
    `VALUES ((SELECT id FROM users WHERE key = ${q(key)}), ${q(key)}, ${q(name)}, ${q(stored)}, 1, datetime('now'));\n`,
);
