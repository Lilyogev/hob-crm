#!/usr/bin/env node
// Writes seed/demo.sql: a few tasks and products so the partners see how the
// board looks. No money anywhere (prices and costs stay 0), no influencers.
// Local only:  npm run db:seed:local
// NEVER run the output on --remote: it wipes every table first.
import { mkdirSync, writeFileSync } from "node:fs";
import { pbkdf2Sync, randomBytes } from "node:crypto";

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const hash = (password) => {
  const salt = randomBytes(16);
  return `pbkdf2-sha256$100000$${salt.toString("hex")}$${pbkdf2Sync(password, salt, 100_000, 32, "sha256").toString("hex")}`;
};
const iso = (d) => d.toISOString().slice(0, 10);
const today = new Date();
const day = (n) => iso(new Date(today.getTime() + n * 86400000));

const lines = [];
const wipe = ["tasks", "reminders", "assistant_chat", "assistant_pending", "brand_memory", "seed_items", "seed_stock", "seed_gifts", "seed_sales", "shopify_push_queue", "fin_expenses", "fin_income", "fin_receipts", "fin_settlements", "fin_settlement_log", "fin_scenarios", "collab_links", "collab_signups", "collab_sales", "collab_prospects", "collab_campaigns", "collab_products", "push_subs", "push_outbox", "notify_log", "sessions", "users"];
for (const t of wipe) lines.push(`DELETE FROM ${t};`);

// Demo logins (local only): avia / demo-avia-2026, lior / demo-lior-2026
lines.push(`INSERT INTO users (key, name, pass_hash, active) VALUES ('avia', 'אביה', ${q(hash("demo-avia-2026"))}, 1);`);
lines.push(`INSERT INTO users (key, name, pass_hash, active) VALUES ('lior', 'ליאור', ${q(hash("demo-lior-2026"))}, 1);`);

// Tasks. group ids from migrations/0001_core.sql: 1 shared, 2 shared follow-up,
// 3 avia, 4 avia follow-up, 5 lior, 6 lior follow-up, 7 this week (shared).
const tasks = [
  [1, "לסגור תאריך לצילומי הקולקציה הבאה", "", "working", "high", "both", day(3)],
  [1, "לבחור 3 משפיעניות לשיתוף פעולה", "רשימה בטאב משפיעניות", "not_started", "medium", "both", day(7)],
  [1, "לעבור על הסימולטור לדרופ הבא", "", "not_started", "", "both", ""],
  [2, "מחכות לתשובה מהספק על הדוגמאות", "", "working", "", "both", day(5)],
  [3, "לספור מלאי אצלי ולעדכן בלוח", "", "not_started", "high", "avia", day(1)],
  [3, "לענות להודעות באינסטגרם", "", "working", "", "avia", ""],
  [4, "מעקב: משלוח שיצא אתמול", "", "working", "", "avia", day(2)],
  [5, "לסגור מחירים עם התופרת", "", "working", "high", "lior", day(2)],
  [5, "לצלם סטורי למוצר החדש", "", "not_started", "low", "lior", ""],
  [6, "מעקב: קוד הנחה למשפיענית", "", "stuck", "", "lior", day(-1)],
  [7, "לפרסם פוסט השקה", "", "not_started", "medium", "both", day(4)],
];
tasks.forEach(([g, title, notes, status, priority, owner, due], i) => {
  lines.push(`INSERT INTO tasks (group_id, title, notes, status, priority, owner, due_date, position, created_by) VALUES (${g}, ${q(title)}, ${q(notes)}, ${q(status)}, ${q(priority)}, ${q(owner)}, ${q(due)}, ${i + 1}, ${q(owner === "lior" ? "lior" : "avia")});`);
});

// Products with stock split between Avia and Lior. Prices and costs are 0 on purpose.
const items = [
  ["שמלת מקסי שחורה", "main", { avia: { s: 2, m: 3, l: 1 }, lior: { s: 1, m: 2, l: 2 } }],
  ["חולצת בייסיק לבנה", "main", { avia: { xs: 2, s: 4, m: 4, l: 2 }, lior: { s: 2, m: 3 } }],
  ["מכנסי פשתן בז'", "main", { avia: { s: 1, m: 2 }, lior: { m: 2, l: 2, xl: 1 } }],
  ["חצאית מידי", "main", { avia: { s: 2, m: 2 }, lior: { s: 1, m: 1, l: 1 } }],
  ["סט טרנינג", "winter", { avia: { m: 3, l: 2 }, lior: { s: 2, m: 2 } }],
];
const SIZES = ["xs", "s", "m", "l", "xl", "xxl"];
items.forEach(([name, collection, stock], i) => {
  lines.push(`INSERT INTO seed_items (id, name, price, unit_cost, collection) VALUES (${i + 1}, ${q(name)}, 0, 0, ${q(collection)});`);
  for (const loc of ["avia", "lior"]) {
    const s = stock[loc] ?? {};
    const cols = SIZES.map((z) => s[z] ?? 0);
    const qty = 0; // sizeless bucket; every demo unit has a size
    lines.push(`INSERT INTO seed_stock (item_id, location, qty, ${SIZES.map((z) => `qty_${z}`).join(", ")}) VALUES (${i + 1}, ${q(loc)}, ${qty}, ${cols.join(", ")});`);
  }
});

// A first note from Hobi.
lines.push(`INSERT INTO assistant_chat (chat_id, role, content, kind) VALUES (1, 'assistant', 'היי אביה וליאור, אני הובי. כתבו לי כאן מה קורה בעסק (מכירה, הוצאה, משימה) ואני ארשום. כדי שאכיר אתכן, מלאו את תיאור המותג בהגדרות.', 'note');`);

lines.push(`INSERT OR REPLACE INTO settings (key, value) VALUES ('brand_name', 'House of Bais');`);

mkdirSync("seed", { recursive: true });
writeFileSync("seed/demo.sql", lines.join("\n") + "\n");
console.log(`seed/demo.sql: ${tasks.length} tasks, ${items.length} products, 2 users (avia / demo-avia-2026, lior / demo-lior-2026), no money`);
