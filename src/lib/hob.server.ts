// Server-only helpers for the hob board: users + sessions, rate limits, the
// settings table and the tasks board (D1 access).
import { bindings } from "./bindings.server";
import { isPartner, OWNERS, type Partner } from "./partners";
import type { D1Database } from "@cloudflare/workers-types";

const COOKIE_NAME = "hob_auth";

export function db(): D1Database {
  const { DB } = bindings();
  if (!DB) throw new Error("D1 binding missing (wrangler.jsonc d1_databases DB)");
  return DB;
}

function hex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Explicit ArrayBuffer backing keeps the type a BufferSource for crypto.subtle.
function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(new ArrayBuffer(n)));
}

function fromHex(s: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(s.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// ---- Password ----
//
// users.pass_hash = "pbkdf2-sha256$<iterations>$<saltHex>$<hashHex>". Set with
// scripts/create-user.mjs (prints SQL for `wrangler d1 execute`), never in a
// migration file. The same format is produced here for password changes.
const PBKDF2_ITERATIONS = 100_000; // Workers' ceiling

export async function hashPassword(password: string, saltHex?: string): Promise<string> {
  const salt = saltHex ? fromHex(saltHex) : randomBytes(16);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${hex(salt)}$${hex(bits)}`;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function matchesHash(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2-sha256") return false;
  const given = await hashPassword(password, parts[2]);
  return timingSafeEqual(given, stored);
}

export type User = { id: number; key: Partner; name: string };

type UserRow = { id: number; key: string; name: string; pass_hash: string; active: number };

/** The user row for a partner key ('avia' | 'lior'), active only. */
export async function findUser(key: string): Promise<UserRow | null> {
  if (!isPartner(key)) return null;
  return db()
    .prepare("SELECT id, key, name, pass_hash, active FROM users WHERE key = ? AND active = 1")
    .bind(key)
    .first<UserRow>();
}

/** Password check for one partner. A user without a hash can never log in. */
export async function verifyPassword(key: string, password: string): Promise<User | null> {
  const row = await findUser(key);
  if (!row || !row.pass_hash) return null;
  if (!(await matchesHash(password, row.pass_hash))) return null;
  return { id: row.id, key: row.key as Partner, name: row.name };
}

/** Change the logged-in user's password after re-checking the current one. */
export async function changePassword(
  userId: number,
  current: string,
  next: string,
): Promise<{ ok: boolean; code?: string }> {
  const row = await db()
    .prepare("SELECT id, key, name, pass_hash, active FROM users WHERE id = ? AND active = 1")
    .bind(userId)
    .first<UserRow>();
  if (!row) return { ok: false, code: "no_user" };
  if (!row.pass_hash || !(await matchesHash(current, row.pass_hash))) return { ok: false, code: "wrong_password" };
  if (next.length < 8 || next.length > 200) return { ok: false, code: "weak_password" };
  await db().prepare("UPDATE users SET pass_hash = ? WHERE id = ?").bind(await hashPassword(next), userId).run();
  return { ok: true };
}

// ---- Sessions ----
//
// One random token per login, stored in `sessions` with the user id; the
// cookie is the token. Logout deletes the row, so a lost phone can be cut off
// from any device by logging out there, or all at once by clearing the table.
const SESSION_DAYS = 180;

export async function createSession(request: Request, userId: number): Promise<string> {
  const token = hex(randomBytes(32));
  const ua = (request.headers.get("user-agent") ?? "").slice(0, 200);
  await db().batch([
    db().prepare("INSERT INTO sessions (token, user_id, ua) VALUES (?, ?, ?)").bind(token, userId, ua),
    db()
      .prepare("DELETE FROM sessions WHERE created_at < datetime('now', ?)")
      .bind(`-${SESSION_DAYS} days`),
  ]);
  return `${COOKIE_NAME}=${token}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearAuthCookie(): string {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

function cookieToken(request: Request): string {
  const cookieHeader = request.headers.get("cookie") ?? "";
  const match = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${COOKIE_NAME}=`));
  const token = match ? match.slice(COOKIE_NAME.length + 1) : "";
  return /^[0-9a-f]{64}$/.test(token) ? token : "";
}

export async function destroySession(request: Request): Promise<void> {
  const token = cookieToken(request);
  if (!token) return;
  await db().prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
}

/** The logged-in user, from the session cookie. null = not logged in. */
export async function currentUser(request: Request): Promise<User | null> {
  const token = cookieToken(request);
  if (!token) return null;
  const row = await db()
    .prepare(
      `SELECT u.id, u.key, u.name FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token = ? AND u.active = 1 AND s.created_at > datetime('now', ?)`,
    )
    .bind(token, `-${SESSION_DAYS} days`)
    .first<{ id: number; key: string; name: string }>();
  if (!row || !isPartner(row.key)) return null;
  return { id: row.id, key: row.key, name: row.name };
}

/** Same as currentUser; the name says what a route means by it. */
export async function requireUser(request: Request): Promise<User | null> {
  return currentUser(request);
}

export async function isAuthed(request: Request): Promise<boolean> {
  return (await currentUser(request)) !== null;
}

// ---- Login brute-force protection (login_attempts) ----
//
// A client IP that fails LIMIT times inside WINDOW_MIN minutes is locked out
// until the window passes; success clears its row. A second, global counter
// (all IPs together) stops an attacker who rotates addresses.
const LOGIN_LIMIT = 5;
const LOGIN_WINDOW_MIN = 15;
const LOGIN_GLOBAL_LIMIT = 40;
const LOGIN_GLOBAL_KEY = "*";

export async function loginLocked(ip: string): Promise<boolean> {
  for (const [key, limit] of [
    [ip, LOGIN_LIMIT],
    [LOGIN_GLOBAL_KEY, LOGIN_GLOBAL_LIMIT],
  ] as const) {
    const row = await db()
      .prepare("SELECT fails FROM login_attempts WHERE ip = ? AND fails >= ? AND window_start > datetime('now', ?)")
      .bind(key, limit, `-${LOGIN_WINDOW_MIN} minutes`)
      .first<{ fails: number }>();
    if (row) return true;
  }
  return false;
}

async function recordFail(ip: string): Promise<void> {
  // An expired window starts over; inside the window the counter climbs.
  await db()
    .prepare(
      `INSERT INTO login_attempts (ip, fails, window_start) VALUES (?, 1, datetime('now'))
       ON CONFLICT(ip) DO UPDATE SET
         fails = CASE WHEN window_start > datetime('now', ?) THEN fails + 1 ELSE 1 END,
         window_start = CASE WHEN window_start > datetime('now', ?) THEN window_start ELSE datetime('now') END`,
    )
    .bind(ip, `-${LOGIN_WINDOW_MIN} minutes`, `-${LOGIN_WINDOW_MIN} minutes`)
    .run();
}

export async function loginFailed(ip: string): Promise<void> {
  await recordFail(ip);
  await recordFail(LOGIN_GLOBAL_KEY);
}

export async function loginSucceeded(ip: string): Promise<void> {
  await db().batch([
    db().prepare("DELETE FROM login_attempts WHERE ip = ?").bind(ip),
    db().prepare("DELETE FROM login_attempts WHERE window_start < datetime('now', '-1 day')"),
  ]);
}

// ---- Rate limiting for public routes ----
//
// A fixed window per key ("signup:<ip>", "miss:<ip>"...). `rateLocked` asks
// whether the key already burned its allowance inside the window; `rateHit`
// records one more event. Rows older than a day are pruned opportunistically.
// Token guessing on the public pages: an address that keeps hitting dead links
// (30 misses in 15 minutes) gets the dead-end page for every token until the
// window passes.
export const MISS_LIMIT = 30;
export const MISS_WINDOW_MIN = 15;

// Link-preview crawlers (WhatsApp, iMessage, Facebook, Slack...) fetch a URL
// the moment it is pasted into a chat. They must not count as "the influencer
// opened her page".
export function isPreviewBot(request: Request): boolean {
  const ua = request.headers.get("user-agent") ?? "";
  return /WhatsApp|TelegramBot|facebookexternalhit|Facebot|Twitterbot|Slackbot|LinkedInBot|Discordbot|iMessageLinkPreview|Applebot|Googlebot|bingbot|preview/i.test(
    ua,
  );
}

export function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}

export async function rateLocked(key: string, limit: number, windowMin: number): Promise<boolean> {
  const row = await db()
    .prepare(
      "SELECT hits FROM rate_limits WHERE key = ? AND hits >= ? AND window_start > datetime('now', ?)",
    )
    .bind(key, limit, `-${windowMin} minutes`)
    .first<{ hits: number }>();
  return !!row;
}

export async function rateHit(key: string, windowMin: number): Promise<void> {
  try {
    const stmts = [
      db()
        .prepare(
          `INSERT INTO rate_limits (key, hits, window_start) VALUES (?, 1, datetime('now'))
           ON CONFLICT(key) DO UPDATE SET
             hits = CASE WHEN window_start > datetime('now', ?) THEN hits + 1 ELSE 1 END,
             window_start = CASE WHEN window_start > datetime('now', ?) THEN window_start ELSE datetime('now') END`,
        )
        .bind(key, `-${windowMin} minutes`, `-${windowMin} minutes`),
    ];
    if (Math.random() < 0.02) {
      stmts.push(db().prepare("DELETE FROM rate_limits WHERE window_start < datetime('now', '-1 day')"));
    }
    await db().batch(stmts);
  } catch {
    // Counting must never break the request itself.
  }
}

export function tooMany(): Response {
  return Response.json({ ok: false, code: "too_many" }, { status: 429 });
}

export function unauthorized(): Response {
  return Response.json({ ok: false, code: "unauthorized" }, { status: 401 });
}

// ---- Settings ----

export async function getSetting(key: string): Promise<string> {
  const row = await db().prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? "";
}

export async function getSettings(keys: readonly string[]): Promise<Record<string, string>> {
  if (!keys.length) return {};
  const res = await db()
    .prepare(`SELECT key, value FROM settings WHERE key IN (${keys.map(() => "?").join(",")})`)
    .bind(...keys)
    .all<{ key: string; value: string }>();
  const out: Record<string, string> = {};
  for (const k of keys) out[k] = "";
  for (const r of res.results ?? []) out[r.key] = r.value;
  return out;
}

export async function putSetting(key: string, value: string): Promise<void> {
  await db()
    .prepare("INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2")
    .bind(key, value)
    .run();
}

// Reach the SummaryAgent Durable Object. Outbound fetch (Anthropic, Shopify,
// push servers) is blocked in route handlers on this platform but works from
// the DO, so all external traffic is relayed through it.
export function agentStub(): { fetch: (url: string, init?: RequestInit) => Promise<Response> } | null {
  const { ROOMS } = bindings();
  if (!ROOMS) return null;
  return ROOMS.get(ROOMS.idFromName("hob-agent")) as unknown as {
    fetch: (url: string, init?: RequestInit) => Promise<Response>;
  };
}

// Fire-and-forget board notification via the DO; must never fail the action.
export async function notifyViaAgent(
  kind: "added" | "completed" | "deleted" | "custom",
  actor: string,
  title: string,
  group?: string,
): Promise<void> {
  try {
    const stub = agentStub();
    if (!stub) return;
    await stub.fetch("https://agent/notify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, actor, title, group }),
    });
  } catch {
    // Notifications must never fail the user's action.
  }
}

// ---- Board data ----

export type Task = {
  id: number;
  group_id: number;
  title: string;
  notes: string;
  status: string;
  priority: string;
  owner: string;
  due_date: string;
  position: number;
  created_by?: string;
  created_at?: string;
  updated_at?: string;
};

export type Group = {
  id: number;
  /** 'shared' | 'avia' | 'lior': which task tab shows this group. */
  view: string;
  title: string;
  color: string;
  position: number;
  tasks: Task[];
  /** Archived tasks in the group. They are not sent on a normal load. */
  archived_count?: number;
};

/** The board. Archived tasks are left out by default: they are most of the
 *  table and the board is polled while the tab is open. archived = "only"
 *  returns just them, for opening the archive. */
export async function getBoard(opts: { archived?: "exclude" | "only" } = {}): Promise<Group[]> {
  const mode = opts.archived ?? "exclude";
  const groupsRes = await db()
    .prepare("SELECT id, view, title, color, position FROM board_groups ORDER BY position, id")
    .all<Omit<Group, "tasks">>();
  const tasksRes = await db()
    .prepare(
      `SELECT id, group_id, title, notes, status, priority, owner, due_date, position, created_by, created_at, updated_at FROM tasks WHERE status ${mode === "only" ? "=" : "<>"} 'archived' ORDER BY position, id`,
    )
    .all<Task>();
  const countsRes = await db()
    .prepare("SELECT group_id, COUNT(*) AS n FROM tasks WHERE status = 'archived' GROUP BY group_id")
    .all<{ group_id: number; n: number }>();
  const counts = new Map((countsRes.results ?? []).map((r) => [r.group_id, r.n]));
  const groups: Group[] = (groupsRes.results ?? []).map((g) => ({ ...g, tasks: [], archived_count: counts.get(g.id) ?? 0 }));
  const byId = new Map(groups.map((g) => [g.id, g]));
  for (const t of tasksRes.results ?? []) byId.get(t.group_id)?.tasks.push(t);
  return groups;
}

const STATUSES = new Set(["not_started", "working", "stuck", "done", "archived"]);
const PRIORITIES = new Set(["", "high", "medium", "low"]);
const OWNER_SET = new Set<string>(OWNERS);

export async function addTask(groupId: number, title: string, createdBy = ""): Promise<Task> {
  const posRow = await db()
    .prepare("SELECT COALESCE(MAX(position), 0) + 1 AS pos FROM tasks WHERE group_id = ?")
    .bind(groupId)
    .first<{ pos: number }>();
  const pos = posRow?.pos ?? 1;
  const res = await db()
    .prepare(
      "INSERT INTO tasks (group_id, title, position, created_by) VALUES (?, ?, ?, ?) RETURNING id, group_id, title, notes, status, priority, owner, due_date, position, created_by",
    )
    .bind(groupId, title, pos, createdBy)
    .first<Task>();
  if (!res) throw new Error("insert failed");
  return res;
}

export async function updateTask(
  id: number,
  patch: Partial<
    Pick<Task, "title" | "notes" | "status" | "priority" | "owner" | "due_date" | "group_id">
  >,
): Promise<boolean> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (typeof patch.title === "string" && patch.title.trim()) {
    sets.push("title = ?");
    values.push(patch.title.trim());
  }
  if (typeof patch.notes === "string") {
    sets.push("notes = ?");
    values.push(patch.notes.trim());
  }
  if (typeof patch.status === "string" && STATUSES.has(patch.status)) {
    sets.push("status = ?");
    values.push(patch.status);
  }
  if (typeof patch.priority === "string" && PRIORITIES.has(patch.priority)) {
    sets.push("priority = ?");
    values.push(patch.priority);
  }
  if (typeof patch.owner === "string" && OWNER_SET.has(patch.owner)) {
    sets.push("owner = ?");
    values.push(patch.owner);
  }
  if (typeof patch.due_date === "string" && /^(\d{4}-\d{2}-\d{2})?$/.test(patch.due_date)) {
    sets.push("due_date = ?");
    values.push(patch.due_date);
  }
  // Drag & drop between groups: verify the target group exists, then append
  // the task to its end.
  if (
    typeof patch.group_id === "number" &&
    Number.isInteger(patch.group_id) &&
    patch.group_id > 0
  ) {
    const target = await db()
      .prepare("SELECT id FROM board_groups WHERE id = ?")
      .bind(patch.group_id)
      .first<{ id: number }>();
    if (target) {
      sets.push("group_id = ?");
      values.push(patch.group_id);
      sets.push(
        "position = (SELECT COALESCE(MAX(position), 0) + 1 FROM tasks WHERE group_id = ?)",
      );
      values.push(patch.group_id);
    }
  }
  if (sets.length === 0) return false;
  sets.push("updated_at = datetime('now')");
  values.push(id);
  await db()
    .prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...values)
    .run();
  return true;
}

export async function deleteTask(id: number): Promise<void> {
  await db().prepare("DELETE FROM tasks WHERE id = ?").bind(id).run();
}
