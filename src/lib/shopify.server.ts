// Shopify Admin API (GraphQL) for the board: weekly report, live stats,
// influencer discount codes, the outbound stock push and the one-time order
// imports. Every function here runs inside the SummaryAgent Durable Object —
// outbound fetch only works there. The shop domain comes from
// settings.shop_domain; credentials are the Worker secrets
// SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET (see SHOPIFY.md).
import type { D1Database } from "@cloudflare/workers-types";
import { normSize, shopifyStockLocation } from "./seeding.server";
import { matchItem, postThreadNote, settingGet, settingPut, sizeFromVariant } from "./shopify-sync.server";

const API_VERSION = "2025-01";
// shopifyqlQuery only exists from Admin API 2025-10, so analytics calls pin
// their own version instead of the module's API_VERSION.
const ANALYTICS_API_VERSION = "2025-10";

export type ShopifyEnv = {
  DB?: D1Database;
  SHOPIFY_CLIENT_ID?: string;
  SHOPIFY_CLIENT_SECRET?: string;
};

// ---- Shop domain + token ----

/** The store's myshopify domain from settings. Throws when not configured. */
export async function shopDomain(db: D1Database | undefined): Promise<string> {
  if (!db) throw new Error("shop_domain not set (DB not bound)");
  const raw = ((await settingGet(db, "shop_domain")) ?? "").trim();
  const domain = raw.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
  if (!domain) throw new Error("shop_domain not set");
  return domain;
}

// Client-credentials apps mint a short-lived Admin API token directly — no
// OAuth redirect. The token lives ~24h; we keep it in DO memory for ~20h and
// mint a fresh one after that (or after a restart).
const TOKEN_TTL_MS = 20 * 3600000;
let tokenCache: { key: string; token: string; expires: number } | null = null;

type Ctx = { domain: string; token: string };

async function mintAccessToken(domain: string, clientId: string, clientSecret: string): Promise<string> {
  const key = `${domain}|${clientId}`;
  if (tokenCache && tokenCache.key === key && tokenCache.expires > Date.now()) return tokenCache.token;
  const res = await fetch(`https://${domain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) throw new Error(`shopify token http ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error("shopify token: empty access_token");
  const ttl = typeof data.expires_in === "number" ? Math.min(TOKEN_TTL_MS, data.expires_in * 1000 - 300000) : TOKEN_TTL_MS;
  tokenCache = { key, token: data.access_token, expires: Date.now() + Math.max(60000, ttl) };
  return data.access_token;
}

function configured(env: ShopifyEnv): boolean {
  return Boolean(env.SHOPIFY_CLIENT_ID && env.SHOPIFY_CLIENT_SECRET);
}

/** Domain + token for one call. Throws with a clear message when unset. */
async function connect(env: ShopifyEnv): Promise<Ctx> {
  if (!configured(env)) throw new Error("missing shopify credentials");
  const domain = await shopDomain(env.DB);
  const token = await mintAccessToken(domain, env.SHOPIFY_CLIENT_ID as string, env.SHOPIFY_CLIENT_SECRET as string);
  return { domain, token };
}

type MoneySet = { shopMoney: { amount: string } };
type OrderNode = {
  createdAt: string;
  currentTotalPriceSet: MoneySet;
  lineItems: { nodes: { title: string; quantity: number }[] };
};
type ProductNode = { title: string; totalInventory: number; status: string };

async function gql<T>(ctx: Ctx, query: string, version = API_VERSION): Promise<T> {
  const res = await fetch(`https://${ctx.domain}/admin/api/${version}/graphql.json`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Shopify-Access-Token": ctx.token },
    body: JSON.stringify({ query }),
  });
  if (res.status === 401) tokenCache = null; // a revoked token: mint again next call
  if (!res.ok) throw new Error(`shopify http ${res.status}`);
  const data = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (data.errors?.length) throw new Error(`shopify: ${data.errors[0].message}`);
  if (!data.data) throw new Error("shopify: empty response");
  return data.data;
}

// ---- Collab program: personal discount codes (needs write_discounts) ----
// Code is sanitized [A-Z0-9] so inlining it in the mutation string is safe;
// the percentage is passed in as a fraction (0.1 = 10%).

// Shopify combines two discounts only when BOTH sides allow the other's
// class. Saying yes to all three classes leaves the decision to the store's
// own automatic discounts, which is where it belongs.
const COMBINES_WITH =
  "combinesWith: { orderDiscounts: true, productDiscounts: true, shippingDiscounts: true }";

type Result = { ok: true } | { ok: false; error: string };

function cleanCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export async function createCollabDiscount(env: ShopifyEnv, code: string, pct: number): Promise<Result> {
  const clean = cleanCode(code);
  if (!clean) return { ok: false, error: "empty code" };
  const fraction = pct > 1 ? pct / 100 : pct;
  if (!(fraction > 0 && fraction <= 0.9)) return { ok: false, error: "bad percent" };
  try {
    const ctx = await connect(env);
    const data = await gql<{
      discountCodeBasicCreate: {
        codeDiscountNode: { id: string } | null;
        userErrors: { message: string }[];
      };
    }>(
      ctx,
      `mutation {
        discountCodeBasicCreate(basicCodeDiscount: {
          title: "COLLAB ${clean}",
          code: "${clean}",
          startsAt: "${new Date().toISOString()}",
          customerSelection: { all: true },
          customerGets: { value: { percentage: ${fraction} }, items: { all: true } },
          appliesOncePerCustomer: false,
          ${COMBINES_WITH}
        }) {
          codeDiscountNode { id }
          userErrors { message }
        }
      }`,
    );
    const errs = data.discountCodeBasicCreate.userErrors;
    if (errs?.length) return { ok: false, error: errs[0].message };
    if (!data.discountCodeBasicCreate.codeDiscountNode) {
      return { ok: false, error: "no discount node returned" };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error).slice(0, 300) };
  }
}

async function findCodeId(ctx: Ctx, clean: string): Promise<string | null> {
  const found = await gql<{ codeDiscountNodeByCode: { id: string } | null }>(
    ctx,
    `{ codeDiscountNodeByCode(code: "${clean}") { id } }`,
  );
  return found.codeDiscountNodeByCode?.id ?? null;
}

// Flips the combination setting on an existing code, so the influencer keeps
// her code (and her attribution) instead of it being deleted and re-created.
export async function combineCollabDiscount(env: ShopifyEnv, code: string): Promise<Result> {
  const clean = cleanCode(code);
  if (!clean) return { ok: false, error: "empty code" };
  try {
    const ctx = await connect(env);
    const id = await findCodeId(ctx, clean);
    if (!id) return { ok: false, error: "code not found" };
    const res = await gql<{ discountCodeBasicUpdate: { userErrors: { message: string }[] } }>(
      ctx,
      `mutation {
        discountCodeBasicUpdate(id: "${id}", basicCodeDiscount: { ${COMBINES_WITH} }) {
          userErrors { message }
        }
      }`,
    );
    const errs = res.discountCodeBasicUpdate.userErrors;
    if (errs?.length) return { ok: false, error: errs[0].message };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error).slice(0, 300) };
  }
}

// סגירת שיתוף פעולה: הקוד נשאר בחנות אבל מפסיק לעבוד (endsAt = עכשיו),
// כך שהזמנות העבר שלה נשארות מיוחסות והעמלה שנצברה לא נעלמת. פתיחה מחדש
// מנקה את התאריך. עדיף על מחיקה, שגם הורסת את ההיסטוריה בשופיפיי.
export async function setCollabDiscountActive(env: ShopifyEnv, code: string, active: boolean): Promise<Result> {
  const clean = cleanCode(code);
  if (!clean) return { ok: false, error: "empty code" };
  try {
    const ctx = await connect(env);
    const id = await findCodeId(ctx, clean);
    if (!id) return { ok: false, error: "code not found" };
    const endsAt = active ? "endsAt: null" : `endsAt: "${new Date().toISOString()}"`;
    const res = await gql<{ discountCodeBasicUpdate: { userErrors: { message: string }[] } }>(
      ctx,
      `mutation {
        discountCodeBasicUpdate(id: "${id}", basicCodeDiscount: { ${endsAt} }) {
          userErrors { message }
        }
      }`,
    );
    const errs = res.discountCodeBasicUpdate.userErrors;
    if (errs?.length) return { ok: false, error: errs[0].message };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error).slice(0, 300) };
  }
}

export async function deleteCollabDiscount(env: ShopifyEnv, code: string): Promise<Result> {
  const clean = cleanCode(code);
  if (!clean) return { ok: false, error: "empty code" };
  try {
    const ctx = await connect(env);
    const id = await findCodeId(ctx, clean);
    if (!id) return { ok: false, error: "code not found" };
    const del = await gql<{ discountCodeDelete: { userErrors: { message: string }[] } }>(
      ctx,
      `mutation { discountCodeDelete(id: "${id}") { userErrors { message } } }`,
    );
    const errs = del.discountCodeDelete.userErrors;
    if (errs?.length) return { ok: false, error: errs[0].message };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error).slice(0, 300) };
  }
}

const nis = (n: number): string =>
  `₪${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

// ---- Online-store traffic via ShopifyQL (needs the read_reports scope) ----

export type Traffic = { sessions: number; purchases: number; conversionPct: number };

// Rows come back as objects keyed by column name with STRING values. The
// conversion is computed here (completed checkouts / sessions) — same math as
// the admin's Analytics overview.
async function trafficFromCtx(ctx: Ctx, days: number): Promise<Traffic | null> {
  const data = await gql<{
    shopifyqlQuery: {
      tableData: {
        rows: { sessions?: string; sessions_that_completed_checkout?: string }[];
      } | null;
      parseErrors: string[];
    };
  }>(
    ctx,
    `{ shopifyqlQuery(query: "FROM sessions SHOW sessions, sessions_that_completed_checkout SINCE -${days}d UNTIL today") { tableData { rows } parseErrors } }`,
    ANALYTICS_API_VERSION,
  );
  const rows = data.shopifyqlQuery?.tableData?.rows ?? [];
  if (!rows.length) return null;
  let sessions = 0;
  let purchases = 0;
  for (const r of rows) {
    sessions += parseInt(r.sessions ?? "0", 10) || 0;
    purchases += parseInt(r.sessions_that_completed_checkout ?? "0", 10) || 0;
  }
  return {
    sessions,
    purchases,
    conversionPct: sessions > 0 ? (purchases / sessions) * 100 : 0,
  };
}

// Store traffic for Hobi's brief: sessions / purchases / conversion over the
// last N days. Never throws — the brief must survive a missing scope, an
// unset domain or a Shopify hiccup.
export async function shopifyTraffic(env: ShopifyEnv, days: number): Promise<Traffic | null> {
  if (!configured(env)) return null;
  try {
    return await trafficFromCtx(await connect(env), days);
  } catch {
    return null;
  }
}

// Compact live stats for Hobi's shop_stats tool — today (Israel calendar
// day) and the trailing week, as JSON the model can read.
export async function shopifyQuickStats(env: ShopifyEnv): Promise<string> {
  if (!configured(env)) return JSON.stringify({ error: "shopify not configured" });
  try {
    const ctx = await connect(env);
    // Israel-day start as UTC (DST-safe via Intl).
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Jerusalem",
      timeZoneName: "shortOffset",
    });
    const tz = fmt.formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value ?? "GMT+3";
    const off = (parseInt(tz.match(/GMT([+-]\d+)/)?.[1] ?? "3", 10) || 3) * 3600000;
    const ilNow = new Date(Date.now() + off);
    const dayStartUtc = new Date(
      Date.UTC(ilNow.getUTCFullYear(), ilNow.getUTCMonth(), ilNow.getUTCDate()) - off,
    ).toISOString();
    const d7 = new Date(Date.now() - 7 * 86400000).toISOString();

    const ordersData = await gql<{ orders: { nodes: OrderNode[] } }>(
      ctx,
      `{ orders(first: 250, query: "created_at:>='${d7}'") {
          nodes {
            createdAt
            currentTotalPriceSet { shopMoney { amount } }
            lineItems(first: 10) { nodes { title quantity } }
          }
        } }`,
    );
    const orders = ordersData.orders.nodes;
    const today = orders.filter((o) => o.createdAt >= dayStartUtc);
    const total = (list: OrderNode[]) =>
      Math.round(list.reduce((acc, o) => acc + parseFloat(o.currentTotalPriceSet.shopMoney.amount), 0));
    const units = new Map<string, number>();
    for (const o of orders) {
      for (const li of o.lineItems.nodes) {
        units.set(li.title, (units.get(li.title) ?? 0) + li.quantity);
      }
    }
    const top = [...units.entries()].sort((a, b) => b[1] - a[1])[0];
    // Traffic needs read_reports — stats stay useful without it if it fails.
    let traffic: Traffic | null = null;
    try {
      traffic = await trafficFromCtx(ctx, 7);
    } catch {
      traffic = null;
    }
    return JSON.stringify({
      today: { orders: today.length, revenue_nis: total(today) },
      last_7_days: { orders: orders.length, revenue_nis: total(orders) },
      top_item_week: top ? { title: top[0], units: top[1] } : null,
      traffic_last_7_days: traffic
        ? {
            sessions: traffic.sessions,
            completed_checkouts: traffic.purchases,
            conversion_pct: Number(traffic.conversionPct.toFixed(2)),
          }
        : null,
    });
  } catch (error) {
    return JSON.stringify({ error: String(error).slice(0, 200) });
  }
}

// ---- What customers were actually charged, per day ----
// The sales ledger stores each line at its catalogue price (the orders/create
// webhook reads line_items[].price, which is BEFORE any discount code and
// carries no shipping). That is the right number for "what did we sell", but
// the wrong one to reconcile against the clearer's deposit. `charged` is the
// order total after discounts and including shipping; `discounts` is what
// the codes took off.
export type ChargedDay = { day: string; orders: number; charged: number; discounts: number };

export async function shopifyCharged(
  env: ShopifyEnv,
  sinceISO: string,
  untilISO: string,
): Promise<{ days: ChargedDay[]; error?: string }> {
  if (!configured(env)) return { days: [], error: "shopify not configured" };
  try {
    const ctx = await connect(env);
    const data = await gql<{
      orders: {
        nodes: {
          createdAt: string;
          currentTotalPriceSet: MoneySet;
          totalDiscountsSet: MoneySet;
        }[];
      };
    }>(
      ctx,
      `{ orders(first: 250, query: "created_at:>='${sinceISO}' AND created_at:<='${untilISO}'") {
          nodes {
            createdAt
            currentTotalPriceSet { shopMoney { amount } }
            totalDiscountsSet { shopMoney { amount } }
          }
        } }`,
    );
    const byDay = new Map<string, ChargedDay>();
    for (const o of data.orders.nodes) {
      const day = o.createdAt.slice(0, 10);
      const row = byDay.get(day) ?? { day, orders: 0, charged: 0, discounts: 0 };
      row.orders += 1;
      row.charged += parseFloat(o.currentTotalPriceSet.shopMoney.amount) || 0;
      row.discounts += parseFloat(o.totalDiscountsSet?.shopMoney?.amount ?? "0") || 0;
      byDay.set(day, row);
    }
    return { days: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)) };
  } catch (error) {
    return { days: [], error: String(error) };
  }
}

// ---- Weekly report (Thursday, into Hobi's thread) ----

async function buildShopifyWeekly(ctx: Ctx, brandName: string): Promise<string> {
  const now = Date.now();
  const d7 = new Date(now - 7 * 86400000).toISOString();
  const d14 = new Date(now - 14 * 86400000).toISOString();

  // Orders of the last 14 days (a weekly report never needs more; without
  // read_all_orders the API only reaches 60 days back anyway).
  const ordersData = await gql<{ orders: { nodes: OrderNode[] } }>(
    ctx,
    `{ orders(first: 250, query: "created_at:>='${d14}'") {
        nodes {
          createdAt
          currentTotalPriceSet { shopMoney { amount } }
          lineItems(first: 10) { nodes { title quantity } }
        }
      } }`,
  );
  const customersData = await gql<{ customersCount: { count: number } }>(
    ctx,
    `{ customersCount { count } }`,
  );
  const productsData = await gql<{ products: { nodes: ProductNode[] } }>(
    ctx,
    `{ products(first: 100, query: "status:active") { nodes { title totalInventory status } } }`,
  );

  const orders = ordersData.orders.nodes;
  const thisWeek = orders.filter((o) => o.createdAt >= d7);
  const lastWeek = orders.filter((o) => o.createdAt < d7);
  const sum = (list: OrderNode[]) =>
    list.reduce((acc, o) => acc + parseFloat(o.currentTotalPriceSet.shopMoney.amount), 0);
  const salesNow = sum(thisWeek);
  const salesPrev = sum(lastWeek);
  const aov = thisWeek.length > 0 ? salesNow / thisWeek.length : 0;

  // Top product of the week by units.
  const units = new Map<string, number>();
  for (const o of thisWeek) {
    for (const li of o.lineItems.nodes) {
      units.set(li.title, (units.get(li.title) ?? 0) + li.quantity);
    }
  }
  const top = [...units.entries()].sort((a, b) => b[1] - a[1])[0];

  const products = productsData.products.nodes;
  const outOfStock = products.filter((p) => p.totalInventory <= 0);
  const lowStock = products.filter((p) => p.totalInventory > 0 && p.totalInventory <= 5);

  const parts: string[] = [];
  parts.push(`🛍️ דוח האתר השבועי — המספרים של השבוע:`);

  const trend =
    salesPrev > 0
      ? salesNow >= salesPrev
        ? `📈 +${Math.round(((salesNow - salesPrev) / salesPrev) * 100)}% משבוע שעבר`
        : `📉 ${Math.round(((salesNow - salesPrev) / salesPrev) * 100)}% משבוע שעבר`
      : salesNow > 0
        ? "📈 שבוע שעבר: ₪0"
        : "";
  parts.push(
    `💰 מכירות 7 ימים: ${nis(salesNow)}${trend ? ` (${trend})` : ""}\n` +
      `📦 הזמנות: ${thisWeek.length}${thisWeek.length > 0 ? ` · ממוצע להזמנה ${nis(aov)}` : ""}`,
  );

  if (top) parts.push(`🏆 הנמכר של השבוע: ${top[0]} (${top[1]} יח')`);

  if (outOfStock.length > 0) {
    const names = outOfStock.slice(0, 5).map((p) => `• ${p.title}`).join("\n");
    const more = outOfStock.length > 5 ? `\n  ...ועוד ${outOfStock.length - 5}` : "";
    parts.push(
      `🚨 אזל מהמלאי (${outOfStock.length} מתוך ${products.length} מוצרים פעילים):\n${names}${more}`,
    );
  } else if (lowStock.length > 0) {
    parts.push(
      `⚠️ מלאי נמוך (5 יח' ומטה):\n${lowStock.slice(0, 5).map((p) => `• ${p.title} — ${p.totalInventory}`).join("\n")}`,
    );
  } else if (products.length > 0) {
    parts.push(`✅ מלאי תקין בכל ${products.length} המוצרים הפעילים`);
  }

  parts.push(`👥 לקוחות ורשומות לתפוצה: ${customersData.customersCount.count.toLocaleString("en-US")}`);

  if (salesNow === 0 && salesPrev === 0) {
    parts.push(
      outOfStock.length === products.length && products.length > 0
        ? `💡 אפס מכירות כי הכל אזל — שבוע כזה שורף כניסות על חנות ריקה. נושא ראשון לשיחה: תאריך השקה/ריסטוק.`
        : `💡 שבועיים בלי מכירות — שווה לפתוח בשאלה מה מביא כניסות לחנות השבוע.`,
    );
  }

  if (brandName) parts.push(`—\n${brandName}`);
  return parts.join("\n\n");
}

export async function runShopifyWeekly(env: ShopifyEnv): Promise<{ ok: boolean; slot: string; error?: string }> {
  const slot = "shopify";
  if (!configured(env)) return { ok: false, slot, error: "SHOPIFY_CLIENT_ID/SECRET not configured" };
  if (!env.DB) return { ok: false, slot, error: "DB not bound" };
  let text: string;
  try {
    const ctx = await connect(env);
    const brand = (await settingGet(env.DB, "brand_name")) ?? "";
    text = await buildShopifyWeekly(ctx, brand);
  } catch (error) {
    return { ok: false, slot, error: String(error).slice(0, 300) };
  }
  try {
    await postThreadNote(env.DB, text, "");
    return { ok: true, slot };
  } catch (error) {
    return { ok: false, slot, error: `board thread write failed: ${String(error).slice(0, 120)}` };
  }
}

// ---- Outbound stock push: board -> store ----
//
// Manual stock changes queue inventory deltas (the stock module writes the
// queue atomically with the stock change); this module drains the queue from
// the Durable Object and applies them to the mapped Shopify variants. Enabled
// only after "מפה מוצרים" (shopify_map) ran and set
// settings.shopify_push_enabled = '1'.

async function ensureLocationId(env: ShopifyEnv, ctx: Ctx): Promise<string | null> {
  if (!env.DB) return null;
  const cached = await settingGet(env.DB, "shopify_location_id");
  if (cached) return cached;
  const data = await gql<{ locations: { nodes: { id: string; isActive: boolean }[] } }>(
    ctx,
    `{ locations(first: 5) { nodes { id isActive } } }`,
  );
  const loc = data.locations.nodes.find((l) => l.isActive) ?? data.locations.nodes[0];
  if (!loc) return null;
  await settingPut(env.DB, "shopify_location_id", loc.id);
  return loc.id;
}

type ItemRow = { id: number; name: string; size: string; web_status: string };

// Items with their web status. The stock module may or may not carry
// seed_items.web_status ('listed' | 'physical_only'); without the column
// every item counts as listed.
async function loadItems(db: D1Database): Promise<ItemRow[]> {
  try {
    return (await db
      .prepare("SELECT id, name, size, COALESCE(web_status, 'listed') AS web_status FROM seed_items")
      .all<ItemRow>()).results ?? [];
  } catch {
    const rows = (await db.prepare("SELECT id, name, size FROM seed_items").all<{ id: number; name: string; size: string }>()).results ?? [];
    return rows.map((r) => ({ ...r, web_status: "listed" }));
  }
}

// The store's live product/variant titles. Renaming a board item to match the
// store is only safe if you can see every title at once — matching is
// token-overlap across the whole catalogue, so a rename that fixes one product
// can push another into a tie. This is the ground truth for that decision.
export async function shopifyProductTitles(env: ShopifyEnv): Promise<{
  titles: string[];
  variants: { product: string; variant: string; qty: number | null; status: string }[];
  error?: string;
}> {
  if (!configured(env)) return { titles: [], variants: [], error: "shopify not configured" };
  try {
    const ctx = await connect(env);
    const data = await gql<{
      products: {
        nodes: {
          title: string;
          status: string;
          variants: { nodes: { title: string; inventoryQuantity: number | null }[] };
        }[];
      };
    }>(
      ctx,
      `{ products(first: 100) { nodes { title status variants(first: 50) { nodes { title inventoryQuantity } } } } }`,
    );
    const titles: string[] = [];
    const variants: { product: string; variant: string; qty: number | null; status: string }[] = [];
    for (const p of data.products.nodes) {
      // Drafts are included on purpose: a product's name has to be checked
      // against the board BEFORE it goes live, because once it is published a
      // wrong name silently decrements the wrong item on the first sale.
      // `titles` stays active-only — that is the live-catalogue view.
      if (p.status === "ACTIVE") {
        for (const v of p.variants.nodes) titles.push(`${p.title} / ${v.title}`);
      }
      for (const v of p.variants.nodes) {
        variants.push({ product: p.title, variant: v.title, qty: v.inventoryQuantity, status: p.status });
      }
    }
    return { titles, variants };
  } catch (error) {
    return { titles: [], variants: [], error: String(error) };
  }
}

// Read-only ShopifyQL passthrough for analytics questions the fixed reports
// do not answer. Reports API only; it cannot write. Callers are already
// behind the board password.
export async function shopifyQL(
  env: ShopifyEnv,
  query: string,
): Promise<{ rows: unknown[]; errors: string[]; error?: string }> {
  if (!configured(env)) return { rows: [], errors: [], error: "shopify not configured" };
  try {
    const ctx = await connect(env);
    const escaped = query.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const data = await gql<{
      shopifyqlQuery: { tableData: { rows: unknown[] } | null; parseErrors: unknown[] };
    }>(
      ctx,
      `{ shopifyqlQuery(query: "${escaped}") { tableData { rows } parseErrors } }`,
      ANALYTICS_API_VERSION,
    );
    return {
      rows: data.shopifyqlQuery?.tableData?.rows ?? [],
      errors: (data.shopifyqlQuery?.parseErrors ?? []).map((e) => JSON.stringify(e)),
    };
  } catch (error) {
    return { rows: [], errors: [], error: String(error).slice(0, 300) };
  }
}

// Build/refresh the (item, size) -> variant map from live store data, cache
// the location, and enable the push. Returns a JSON report for Hobi / the UI.
export async function buildVariantMap(env: ShopifyEnv): Promise<string> {
  if (!env.DB || !configured(env)) return JSON.stringify({ ok: false, error: "shopify not configured" });
  try {
    const ctx = await connect(env);
    const data = await gql<{
      products: {
        nodes: {
          title: string;
          status: string;
          variants: { nodes: { id: string; title: string; inventoryItem: { id: string } }[] };
        }[];
      };
    }>(
      ctx,
      `{ products(first: 100) { nodes { title status variants(first: 50) { nodes { id title inventoryItem { id } } } } } }`,
    );
    const allItems = await loadItems(env.DB);
    // פריט "מלאי פיזי בלבד" לא מקבל מיפוי: אחרת עדכון מלאי שלו היה נדחף לחנות.
    const physicalOnly = allItems.filter((i) => i.web_status === "physical_only").map((i) => i.name);
    const items = allItems.filter((i) => i.web_status !== "physical_only");
    let mapped = 0;
    const unmatched: string[] = [];
    for (const p of data.products.nodes) {
      if (p.status !== "ACTIVE") continue;
      for (const v of p.variants.nodes) {
        const size = normSize(sizeFromVariant(v.title));
        const match = matchItem(`${p.title} ${v.title}`, items);
        if (!match) {
          unmatched.push(`${p.title} / ${v.title}`);
          continue;
        }
        await env.DB.prepare(
          `INSERT INTO seed_variant_map (item_id, size, variant_id, inventory_item_id, variant_title)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(item_id, size) DO UPDATE SET variant_id = excluded.variant_id,
             inventory_item_id = excluded.inventory_item_id,
             variant_title = excluded.variant_title, updated_at = datetime('now')`,
        )
          .bind(match.id, size, v.id, v.inventoryItem.id, `${p.title} / ${v.title}`)
          .run();
        mapped++;
      }
    }
    const locationId = await ensureLocationId(env, ctx);
    if (mapped > 0 && locationId) await settingPut(env.DB, "shopify_push_enabled", "1");
    return JSON.stringify({
      ok: true,
      mapped_variants: mapped,
      unmatched,
      physical_only_not_mapped: physicalOnly,
      push_enabled: mapped > 0 && Boolean(locationId),
    });
  } catch (error) {
    return JSON.stringify({ ok: false, error: String(error).slice(0, 200) });
  }
}

type QueueRow = {
  id: number;
  item_id: number;
  size: string;
  delta: number;
  inventory_item_id: string | null;
  web_status: string;
};

async function loadQueue(db: D1Database): Promise<QueueRow[]> {
  const base = (webStatus: string) =>
    `SELECT q.id, q.item_id, q.size, q.delta, m.inventory_item_id, ${webStatus} AS web_status
     FROM shopify_push_queue q
     LEFT JOIN seed_variant_map m ON m.item_id = q.item_id AND m.size = q.size
     LEFT JOIN seed_items i ON i.id = q.item_id
     ORDER BY q.id LIMIT 20`;
  try {
    return (await db.prepare(base("COALESCE(i.web_status, 'listed')")).all<QueueRow>()).results ?? [];
  } catch {
    return (await db.prepare(base("'listed'")).all<QueueRow>()).results ?? [];
  }
}

export async function drainShopifyPushQueue(env: ShopifyEnv): Promise<{ pushed: number; skipped: number; failed: number }> {
  const out = { pushed: 0, skipped: 0, failed: 0 };
  const db = env.DB;
  if (!db || !configured(env)) return out;
  try {
    if ((await settingGet(db, "shopify_push_enabled")) !== "1") return out;
    const rows = await loadQueue(db);
    if (!rows.length) return out;
    // פריט שלא מוצג באתר בכוונה: נמחק מהתור בשקט. זה לא "חסר התאמה" ולא תקלה.
    const physicalOnly = rows.filter((r) => r.web_status === "physical_only");
    for (const r of physicalOnly) {
      await db.prepare("DELETE FROM shopify_push_queue WHERE id = ?").bind(r.id).run();
      out.skipped++;
    }
    const live = rows.filter((r) => r.web_status !== "physical_only");
    const unmapped = live.filter((r) => !r.inventory_item_id);
    for (const r of unmapped) {
      await db.prepare("DELETE FROM shopify_push_queue WHERE id = ?").bind(r.id).run();
      out.skipped++;
    }
    const mapped = live.filter((r) => r.inventory_item_id);
    if (mapped.length) {
      const ctx = await connect(env);
      const locationId = await ensureLocationId(env, ctx);
      if (!locationId) throw new Error("no shopify location");
      const agg = new Map<string, number>();
      for (const r of mapped) {
        agg.set(r.inventory_item_id as string, (agg.get(r.inventory_item_id as string) ?? 0) + r.delta);
      }
      const changes = [...agg.entries()].filter(([, d]) => d !== 0);
      if (changes.length) {
        const changesStr = changes
          .map(([inv, d]) => `{inventoryItemId: "${inv}", locationId: "${locationId}", delta: ${d}}`)
          .join(", ");
        const res = await gql<{ inventoryAdjustQuantities: { userErrors: { message: string }[] } }>(
          ctx,
          `mutation { inventoryAdjustQuantities(input: {reason: "correction", name: "available", changes: [${changesStr}]}) { userErrors { message } } }`,
        );
        const errs = res.inventoryAdjustQuantities?.userErrors ?? [];
        if (errs.length) throw new Error(errs[0].message);
      }
      for (const r of mapped) {
        await db.prepare("DELETE FROM shopify_push_queue WHERE id = ?").bind(r.id).run();
        out.pushed++;
      }
    }
    if (unmapped.length) {
      await postThreadNote(
        db,
        `⚠️ סנכרון לאתר: ${unmapped.length} עדכוני מלאי דולגו כי אין להם התאמה בחנות. שווה להריץ "מפה מוצרים" (או לבקש מהובי: "חברי את המלאי לאתר").`,
      );
    }
    return out;
  } catch (error) {
    out.failed++;
    try {
      await postThreadNote(db, `⚠️ עדכון מלאי לאתר נכשל (ינוסה שוב אוטומטית): ${String(error).slice(0, 150)}`);
    } catch {
      // A failed alert must not break the caller.
    }
    return out;
  }
}

// ---- Historical order import (before the board existed) ----
//
// Pulls EVERY store order that is not yet in the ledger and logs it as an
// archive row: item_id NULL (no stock movement), ship_status 'delivered',
// channel 'archive' (excluded from current totals), created_at + sold_at =
// the REAL order date so time-windowed briefs never see the import as a
// sales spike. Buyer contact comes along, so the sales log unifies a
// customer's history. Dedupe is by the #<n> token, tolerant of hand-edited
// note suffixes. Safe to re-run. Orders older than 60 days need the
// read_all_orders scope.
export async function importArchiveOrders(env: ShopifyEnv): Promise<string> {
  const db = env.DB;
  if (!db || !configured(env)) return JSON.stringify({ ok: false, error: "shopify not configured" });
  try {
    const noteRows = await db
      .prepare("SELECT DISTINCT note FROM seed_sales WHERE note LIKE '%#%'")
      .all<{ note: string }>();
    const logged = new Set<string>();
    for (const r of noteRows.results ?? []) {
      const m = /#\d+/.exec(r.note);
      if (m) logged.add(m[0]);
    }
    const location = await shopifyStockLocation(db);

    type ArchiveNode = {
      name: string;
      createdAt: string;
      cancelledAt: string | null;
      email: string | null;
      phone: string | null;
      customer: { firstName: string | null; lastName: string | null; email: string | null; phone: string | null } | null;
      shippingAddress: { address1: string | null; address2: string | null; city: string | null; zip: string | null; phone: string | null } | null;
      lineItems: {
        nodes: {
          title: string;
          quantity: number;
          variantTitle: string | null;
          originalUnitPriceSet: { shopMoney: { amount: string } };
        }[];
      };
    };
    const ctx = await connect(env);
    const orders: ArchiveNode[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const data: {
        orders: { nodes: ArchiveNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
      } = await gql(
        ctx,
        `{ orders(first: 100${cursor ? `, after: "${cursor}"` : ""}, query: "status:any") { nodes { name createdAt cancelledAt email phone customer { firstName lastName email phone } shippingAddress { address1 address2 city zip phone } lineItems(first: 30) { nodes { title quantity variantTitle originalUnitPriceSet { shopMoney { amount } } } } } pageInfo { hasNextPage endCursor } } }`,
      );
      orders.push(...data.orders.nodes);
      if (!data.orders.pageInfo.hasNextPage) break;
      cursor = data.orders.pageInfo.endCursor;
    }

    let importedOrders = 0;
    let importedRows = 0;
    let skipped = 0;
    for (const o of orders) {
      if (o.cancelledAt) continue; // cancelled orders are not customers
      const orderNo = /#\d+/.exec(o.name)?.[0] ?? o.name;
      if (logged.has(orderNo)) {
        skipped++;
        continue;
      }
      const buyer =
        [o.customer?.firstName, o.customer?.lastName].filter(Boolean).join(" ").trim() || "לקוחת האתר";
      const phone = (o.shippingAddress?.phone ?? o.phone ?? o.customer?.phone ?? "").trim();
      const email = (o.email ?? o.customer?.email ?? "").trim();
      const address = [o.shippingAddress?.address1, o.shippingAddress?.address2, o.shippingAddress?.city, o.shippingAddress?.zip]
        .map((p) => (p ?? "").trim())
        .filter(Boolean)
        .join(", ");
      const soldAt = o.createdAt.slice(0, 10);
      const createdAt = `${soldAt} ${o.createdAt.slice(11, 19)}`;
      for (const li of o.lineItems.nodes) {
        const size = sizeFromVariant(li.variantTitle);
        const label = li.variantTitle ? `${li.title} (${li.variantTitle})` : li.title;
        await db
          .prepare(
            `INSERT INTO seed_sales (item_id, item_label, buyer, buyer_phone, buyer_email, buyer_address, qty, size, location, price, ship_status, pay_method, handled_by, channel, note, sold_at, order_ref, created_at)
             VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'delivered', 'shopify', '', 'archive', ?, ?, ?, ?)`,
          )
          .bind(
            label,
            buyer,
            phone,
            email,
            address,
            li.quantity,
            size,
            location,
            parseFloat(li.originalUnitPriceSet.shopMoney.amount) || 0,
            `Shopify ${orderNo} · ארכיון`,
            soldAt,
            orderNo,
            createdAt,
          )
          .run();
        importedRows++;
      }
      importedOrders++;
    }
    return JSON.stringify({
      ok: true,
      orders_in_store: orders.length,
      imported_orders: importedOrders,
      imported_rows: importedRows,
      already_logged: skipped,
    });
  } catch (error) {
    return JSON.stringify({ ok: false, error: String(error).slice(0, 300) });
  }
}

// ---- Contact backfill for already-synced store orders ----
//
// Pulls phone / email / shipping address for every "Shopify #<n>" sale row
// that has no contact yet, straight from the Admin API. Only EMPTY columns
// are filled — anything the partners typed by hand wins. Safe to re-run.
export async function backfillOrderContacts(env: ShopifyEnv): Promise<string> {
  const db = env.DB;
  if (!db || !configured(env)) return JSON.stringify({ ok: false, error: "shopify not configured" });
  try {
    const pending = await db
      .prepare(
        `SELECT DISTINCT note FROM seed_sales
         WHERE note LIKE 'Shopify %' AND buyer_phone = '' AND buyer_email = '' AND buyer_address = ''`,
      )
      .all<{ note: string }>();
    const notes = (pending.results ?? []).map((r) => r.note);
    if (!notes.length) return JSON.stringify({ ok: true, orders: 0, updated: 0, missing: [] });

    type ContactNode = {
      name: string;
      email: string | null;
      phone: string | null;
      customer: { email: string | null; phone: string | null } | null;
      shippingAddress: { address1: string | null; address2: string | null; city: string | null; zip: string | null; phone: string | null } | null;
    };
    const ctx = await connect(env);
    const byName = new Map<string, ContactNode>();
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const data: {
        orders: { nodes: ContactNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
      } = await gql(
        ctx,
        `{ orders(first: 100${cursor ? `, after: "${cursor}"` : ""}, query: "status:any") { nodes { name email phone customer { email phone } shippingAddress { address1 address2 city zip phone } } pageInfo { hasNextPage endCursor } } }`,
      );
      for (const node of data.orders.nodes) byName.set(node.name, node);
      if (!data.orders.pageInfo.hasNextPage) break;
      cursor = data.orders.pageInfo.endCursor;
    }

    let updated = 0;
    const missing: string[] = [];
    for (const note of notes) {
      // The partners append status text to the note ("Shopify #1063 בוצע") —
      // match by the order number token alone, update by the full note.
      const orderNo = /#\d+/.exec(note)?.[0] ?? "";
      const node = byName.get(orderNo);
      if (!node) {
        missing.push(orderNo);
        continue;
      }
      const phone = (node.shippingAddress?.phone ?? node.phone ?? node.customer?.phone ?? "").trim();
      const email = (node.email ?? node.customer?.email ?? "").trim();
      const address = [node.shippingAddress?.address1, node.shippingAddress?.address2, node.shippingAddress?.city, node.shippingAddress?.zip]
        .map((p) => (p ?? "").trim())
        .filter(Boolean)
        .join(", ");
      if (!phone && !email && !address) continue;
      const res = await db
        .prepare(
          `UPDATE seed_sales SET
             buyer_phone   = CASE WHEN buyer_phone   = '' THEN ? ELSE buyer_phone   END,
             buyer_email   = CASE WHEN buyer_email   = '' THEN ? ELSE buyer_email   END,
             buyer_address = CASE WHEN buyer_address = '' THEN ? ELSE buyer_address END,
             updated_at = datetime('now')
           WHERE note = ?`,
        )
        .bind(phone, email, address, note)
        .run();
      updated += res.meta.changes ?? 0;
    }
    return JSON.stringify({ ok: true, orders: notes.length, updated, missing });
  } catch (error) {
    // A store without protected-customer-data approval errors here — surface
    // the exact message so the fix (the app's data-protection form) is
    // obvious instead of a silent zero.
    return JSON.stringify({ ok: false, error: String(error).slice(0, 300) });
  }
}
