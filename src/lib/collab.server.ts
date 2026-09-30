import type { D1Database } from "@cloudflare/workers-types";
import { agentStub, db } from "./hob.server";
import { addGift } from "./seeding.server";
import { isPartner } from "./partners";

// ---- Influencer collab program (משפיענים) ----
//
// One active campaign at a time. Each influencer gets a personal invite link
// (/c/<token>) that renders the public signup page with her name on it; a
// signup lands in collab_signups and drops a note into Hobi's board thread so
// the badge lights up. Her personal discount code is minted in the store
// through the DO (the only place with egress); an order paid with that code
// is attributed to her in collab_sales and earns her the commission.
//
// Domains and percentages come from `settings` — nothing is hardcoded here.

// Hobi's board thread (assistant_chat.chat_id). kind='note' rows are shown in
// the chat but never sent to the model.
const BOARD_CHAT_ID = 1;

export type CollabCampaign = {
  id: number;
  slug: string;
  title: string;
  product_name: string;
  product_value: number;
  asks: string;
  brief: string;
  sizes: string;
  colors: string;
  active: number;
};

export type CollabProduct = {
  id: number;
  campaign_id: number;
  name: string;
  value: number;
  image: string;
  sizes: string;
  colors: string;
  active: number;
};

export type CollabLink = {
  id: number;
  token: string;
  campaign_id: number;
  name: string;
  instagram: string;
  product_id: number | null;
  picks: number;
  views: number;
  discount_code: string;
  sale_clicks: number;
  personal_note: string;
  is_generic: number;
  gender: string;
  commission_paid: number;
  combines_ok: number;
  code_ended_at: string;
  handled_by: string;
  created_at: string;
  signups?: number;
  sales_count?: number;
  sales_total?: number;
};

export type CollabSignup = {
  id: number;
  link_id: number | null;
  campaign_id: number;
  full_name: string;
  instagram: string;
  phone: string;
  email: string;
  size: string;
  color: string;
  product: string;
  item_id: number;
  items: string;
  gift_logged: number;
  status_at: string;
  reel_url: string;
  reel_views: number;
  file_received: number;
  address: string;
  city: string;
  apt: string;
  floor: string;
  is_private: number;
  zip: string;
  status: string;
  created_at: string;
};

export const SIGNUP_STATUSES = ["pending", "signed", "sent", "posted", "done"] as const;

// ---- Settings (domains, percentages, brand) ----

export type CollabSettings = {
  brandName: string;
  /** Public base for invite / stats / sale links, no trailing slash. */
  base: string;
  /** The store's URL, no trailing slash ('' when not configured). */
  storeUrl: string;
  /** Whole percents (10 = 10%). */
  discountPct: number;
  commissionPct: number;
  /** Optional extras: the brand's instagram handle, a WhatsApp number for the
   *  public page, a hero image URL, the stock location gifts are taken from. */
  instagram: string;
  whatsapp: string;
  heroUrl: string;
  giftLocation: string;
};

function normalizeOrigin(raw: string): string {
  const v = raw.trim().replace(/\/+$/, "");
  if (!v) return "";
  return /^https?:\/\//i.test(v) ? v : `https://${v}`;
}

function pct(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : fallback;
}

// `origin` is the request origin, used when collab_domain is not set yet.
export async function collabSettings(origin = ""): Promise<CollabSettings> {
  const map: Record<string, string> = {};
  try {
    const res = await db()
      .prepare(
        `SELECT key, value FROM settings WHERE key IN
         ('brand_name','collab_domain','store_url','collab_discount_pct','collab_commission_pct',
          'brand_instagram','collab_whatsapp','collab_hero_url','gift_stock_location')`,
      )
      .all<{ key: string; value: string }>();
    for (const r of res.results ?? []) map[r.key] = r.value;
  } catch {
    // Defaults below keep the public pages alive even without settings.
  }
  const base = normalizeOrigin(map.collab_domain ?? "") || normalizeOrigin(origin);
  return {
    brandName: (map.brand_name ?? "").trim() || "hob",
    base,
    storeUrl: normalizeOrigin(map.store_url ?? ""),
    discountPct: pct(map.collab_discount_pct, 10),
    commissionPct: pct(map.collab_commission_pct, 10),
    instagram: (map.brand_instagram ?? "").trim().replace(/^@/, ""),
    whatsapp: (map.collab_whatsapp ?? "").replace(/\D/g, ""),
    heroUrl: (map.collab_hero_url ?? "").trim(),
    giftLocation: isPartner(map.gift_stock_location) ? map.gift_stock_location : "avia",
  };
}

export function pageURL(s: CollabSettings, token: string): string {
  return `${s.base}/c/${token}`;
}
export function saleURL(s: CollabSettings, code: string): string {
  return `${s.base}/s/${code}`;
}
export function myURL(s: CollabSettings, token: string): string {
  return `${s.base}/my/${token}`;
}
// Where /s/<code> forwards: the store's native discount redirect.
export function discountURL(s: CollabSettings, code: string): string {
  return s.storeUrl ? `${s.storeUrl}/discount/${code}` : "/";
}

function handledBy(x: unknown): string {
  return isPartner(x) ? x : "";
}

// ---- Stock offers for the pick-from-stock page ----
//
// Real inventory, summed across both locations, only in-stock sizes. One-size
// items use the plain qty bucket and render without a size picker. Reads the
// stock tables directly and fails soft (no offers → the fixed product shows).
export type StockOffer = {
  id: number;
  name: string;
  price: number;
  image: string;
  sizes: string[];
};

const SIZE_BUCKETS: [string, string][] = [
  ["xs", "XS"],
  ["s", "S"],
  ["m", "M"],
  ["l", "L"],
  ["xl", "XL"],
  ["xxl", "XXL"],
];

export async function stockOffers(): Promise<StockOffer[]> {
  let rows: Record<string, unknown>[] = [];
  try {
    const res = await db()
      .prepare(
        `SELECT i.*,
                COALESCE(SUM(s.qty),0) tq,
                COALESCE(SUM(s.qty_xs),0) xs, COALESCE(SUM(s.qty_s),0) s,
                COALESCE(SUM(s.qty_m),0) m, COALESCE(SUM(s.qty_l),0) l,
                COALESCE(SUM(s.qty_xl),0) xl, COALESCE(SUM(s.qty_xxl),0) xxl
         FROM seed_items i LEFT JOIN seed_stock s ON s.item_id = i.id
         GROUP BY i.id
         ORDER BY i.price DESC, i.id`,
      )
      .all<Record<string, unknown>>();
    rows = res.results ?? [];
  } catch {
    return [];
  }
  const offers: StockOffer[] = [];
  for (const r of rows) {
    const sizes = SIZE_BUCKETS.filter(([k]) => Number(r[k]) > 0).map(([, label]) => label);
    const oneSizeQty = Number(r.tq);
    if (!sizes.length && oneSizeQty <= 0) continue; // fully out of stock
    offers.push({
      id: Number(r.id),
      name: String(r.name ?? ""),
      price: Number(r.price) || 0,
      image: typeof r.image === "string" ? r.image : "",
      sizes,
    });
  }
  return offers;
}

// ---- Campaign ----

export async function activeCampaign(): Promise<CollabCampaign | null> {
  return await db()
    .prepare("SELECT * FROM collab_campaigns WHERE active = 1 ORDER BY id DESC LIMIT 1")
    .first<CollabCampaign>();
}

// The tab needs a campaign row to hang links on. Created once, structure only
// (no product, no value) — the partners fill the copy in the tab.
export async function ensureCampaign(): Promise<CollabCampaign> {
  const existing = await activeCampaign();
  if (existing) return existing;
  await db()
    .prepare("INSERT OR IGNORE INTO collab_campaigns (slug, title) VALUES ('main', 'קמפיין משפיענים')")
    .run();
  await db().prepare("UPDATE collab_campaigns SET active = 1 WHERE slug = 'main'").run();
  const row = await activeCampaign();
  if (!row) throw new Error("campaign insert failed");
  return row;
}

export async function campaignProducts(campaignId: number): Promise<CollabProduct[]> {
  const res = await db()
    .prepare("SELECT * FROM collab_products WHERE campaign_id = ? AND active = 1 ORDER BY id")
    .bind(campaignId)
    .all<CollabProduct>();
  return res.results ?? [];
}

export async function updateCampaign(
  id: number,
  fields: { title?: string; product_name?: string; product_value?: number; brief?: string; asks?: string },
): Promise<void> {
  const sets: string[] = [];
  const binds: (string | number)[] = [];
  if (typeof fields.title === "string" && fields.title.trim()) {
    sets.push("title = ?");
    binds.push(fields.title.trim().slice(0, 120));
  }
  if (typeof fields.product_name === "string") {
    sets.push("product_name = ?");
    binds.push(fields.product_name.slice(0, 120));
  }
  if (typeof fields.product_value === "number" && Number.isFinite(fields.product_value)) {
    sets.push("product_value = ?");
    binds.push(Math.max(0, Math.round(fields.product_value)));
  }
  if (typeof fields.brief === "string") {
    sets.push("brief = ?");
    binds.push(fields.brief.slice(0, 2000));
  }
  if (typeof fields.asks === "string") {
    sets.push("asks = ?");
    binds.push(fields.asks.slice(0, 500));
  }
  if (!sets.length) return;
  binds.push(id);
  await db()
    .prepare(`UPDATE collab_campaigns SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();
}

// ---- Links ----

export async function linkByToken(
  token: string,
): Promise<{
  link: CollabLink;
  campaign: CollabCampaign;
  product: CollabProduct;
  products: CollabProduct[];
  offers: StockOffer[];
} | null> {
  const link = await db()
    .prepare("SELECT * FROM collab_links WHERE token = ?")
    .bind(token)
    .first<CollabLink>();
  if (!link) return null;
  const campaign = await db()
    .prepare("SELECT * FROM collab_campaigns WHERE id = ?")
    .bind(link.campaign_id)
    .first<CollabCampaign>();
  if (!campaign) return null;
  const products = await campaignProducts(campaign.id);
  let product: CollabProduct | null = null;
  if (link.product_id != null) {
    product = await db()
      .prepare("SELECT * FROM collab_products WHERE id = ?")
      .bind(link.product_id)
      .first<CollabProduct>();
  }
  if (!product) {
    // product_id NULL = the influencer picks on the page; the fallback also
    // covers deleted products. Last resort: campaign-level product fields.
    product = products[0] ?? {
      id: 0,
      campaign_id: campaign.id,
      name: campaign.product_name,
      value: campaign.product_value,
      image: "",
      sizes: campaign.sizes,
      colors: campaign.colors,
      active: 1,
    };
  }
  const offers = link.product_id == null ? await stockOffers() : [];
  return { link, campaign, product, products, offers };
}

// Token: instagram handle when we have one (latin, reads nicely in the URL),
// otherwise a neutral word — plus 12 random chars (31-letter alphabet ≈ 59
// bits) so links can't be enumerated even when the handle is known.
function makeToken(instagram: string): string {
  const base =
    instagram
      .toLowerCase()
      .replace(/[^a-z0-9._]/g, "")
      .replace(/\.+/g, "-")
      .slice(0, 24) || "vip";
  const abc = "abcdefghjkmnpqrstuvwxyz23456789";
  let rand = "";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  for (const b of bytes) rand += abc[b % abc.length];
  return `${base}-${rand}`;
}

export async function createLink(
  campaignId: number,
  name: string,
  instagram: string,
  productId: number | null,
  picks: number,
  personalNote = "",
  generic = false,
  gender = "",
  handled = "",
): Promise<CollabLink> {
  const token = makeToken(instagram);
  const p = productId == null ? Math.min(3, Math.max(1, Math.round(picks) || 1)) : 1;
  await db()
    .prepare(
      `INSERT INTO collab_links
       (token, campaign_id, name, instagram, product_id, picks, personal_note, is_generic, gender, handled_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      token,
      campaignId,
      name.slice(0, 80),
      instagram.replace(/^@/, "").slice(0, 80),
      productId,
      p,
      personalNote.trim().slice(0, 200),
      generic ? 1 : 0,
      gender === "m" || gender === "f" ? gender : "",
      handledBy(handled),
    )
    .run();
  const row = await db()
    .prepare("SELECT * FROM collab_links WHERE token = ?")
    .bind(token)
    .first<CollabLink>();
  if (!row) throw new Error("link insert failed");
  return row;
}

// Who handles this influencer (a link or a prospect). '' = nobody yet.
export async function setHandledBy(
  kind: "link" | "prospect",
  id: number,
  who: string,
): Promise<void> {
  const table = kind === "link" ? "collab_links" : "collab_prospects";
  await db()
    .prepare(`UPDATE ${table} SET handled_by = ? WHERE id = ?`)
    .bind(handledBy(who), id)
    .run();
}

// A closed collaboration behaves like an unknown code: an old story link
// lands on the plain store instead of a dead discount URL, and the click is
// not counted because it can no longer become a sale.
export async function saleCodeExists(code: string): Promise<boolean> {
  try {
    const row = await db()
      .prepare("SELECT 1 AS x FROM collab_links WHERE UPPER(discount_code) = ? AND code_ended_at = ''")
      .bind(code.toUpperCase())
      .first<{ x: number }>();
    return !!row;
  } catch {
    return false;
  }
}

export async function countSaleClick(code: string): Promise<boolean> {
  try {
    const res = await db()
      .prepare("UPDATE collab_links SET sale_clicks = sale_clicks + 1 WHERE UPPER(discount_code) = ? AND code_ended_at = ''")
      .bind(code.toUpperCase())
      .run();
    return (res.meta.changes ?? 0) > 0;
  } catch {
    return false;
  }
}

export async function updateLinkNote(id: number, note: string): Promise<void> {
  await db()
    .prepare("UPDATE collab_links SET personal_note = ? WHERE id = ?")
    .bind(note.trim().slice(0, 200), id)
    .run();
}

export async function countLinkView(token: string): Promise<void> {
  try {
    await db()
      .prepare("UPDATE collab_links SET views = views + 1 WHERE token = ?")
      .bind(token)
      .run();
  } catch {
    // Never let analytics break the public page.
  }
}

// ---- Discount codes (through the DO) ----
//
// Personal discount code: the influencer's own name + the buyer's percentage
// (NOA10). Prefers the latin instagram handle; a Hebrew name is
// transliterated (נועה→NOA); a random base is the last resort so a code
// always exists.
const HEB_LATIN: Record<string, string> = {
  "א": "A", "ב": "B", "ג": "G", "ד": "D", "ה": "H", "ו": "O", "ז": "Z",
  "ח": "H", "ט": "T", "י": "I", "כ": "K", "ך": "K", "ל": "L", "מ": "M",
  "ם": "M", "נ": "N", "ן": "N", "ס": "S", "ע": "A", "פ": "P", "ף": "F",
  "צ": "TZ", "ץ": "TZ", "ק": "K", "ר": "R", "ש": "SH", "ת": "T",
};

function transliterate(name: string): string {
  // First word only — the code should read like her name, not a sentence.
  const first = name.trim().split(/\s+/)[0] ?? "";
  let out = "";
  for (const ch of first) {
    if (/[a-zA-Z0-9]/.test(ch)) out += ch.toUpperCase();
    else out += HEB_LATIN[ch] ?? "";
  }
  // A trailing ה sounds like A in names (נועה, שרה).
  if (first.endsWith("ה") && out.endsWith("H")) out = out.slice(0, -1) + "A";
  // Collapse doubled letters the mapping can produce (נועה → NOAA → NOA).
  out = out.replace(/(.)\1+/g, "$1");
  return out.slice(0, 10);
}

function randomLetters(n: number): string {
  const abc = "ABCDEFGHJKMNPQRSTUVWXYZ";
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(bytes, (b) => abc[b % abc.length]).join("");
}

function makeDiscountCode(name: string, instagram: string, discountPct: number): string {
  let base = instagram
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 10);
  if (!base) base = transliterate(name);
  if (base.length < 2) base = "VIP" + randomLetters(3);
  return `${base}${Math.round(discountPct)}`;
}

// Creates the code in the store through the DO (only place with egress) and
// stores it on the link. Failure leaves the link code-less — the tab shows a
// retry button, and everything else about the link keeps working.
export async function ensureDiscountCode(
  linkId: number,
): Promise<{ ok: boolean; code?: string; error?: string }> {
  const link = await db()
    .prepare("SELECT * FROM collab_links WHERE id = ?")
    .bind(linkId)
    .first<CollabLink>();
  if (!link) return { ok: false, error: "link not found" };
  if (link.discount_code) return { ok: true, code: link.discount_code };
  const settings = await collabSettings();
  let code = makeDiscountCode(link.name, link.instagram, settings.discountPct);
  const clash = await db()
    .prepare("SELECT id FROM collab_links WHERE UPPER(discount_code) = ? LIMIT 1")
    .bind(code.toUpperCase())
    .first<{ id: number }>();
  if (clash) code = makeDiscountCode("", "", settings.discountPct);
  const stub = agentStub();
  if (!stub) return { ok: false, error: "agent unavailable" };
  const tryCreate = async (c: string): Promise<{ ok: boolean; error?: string }> => {
    const res = await stub.fetch("https://agent/collab-discount", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: c, pct: settings.discountPct / 100 }),
    });
    return (await res.json()) as { ok: boolean; error?: string };
  };
  const suffix = String(Math.round(settings.discountPct));
  try {
    let data = await tryCreate(code);
    // A code that already exists in the store (a past influencer, a store
    // coupon) gets one retry with a random suffix instead of a dead end.
    if (!data.ok && /taken|exists|בשימוש/i.test(data.error ?? "")) {
      code = `${code.slice(0, -suffix.length)}${randomLetters(2)}${suffix}`;
      data = await tryCreate(code);
    }
    if (!data.ok) return { ok: false, error: data.error ?? "unknown" };
  } catch (error) {
    return { ok: false, error: String(error).slice(0, 200) };
  }
  await db()
    .prepare("UPDATE collab_links SET discount_code = ?, combines_ok = 1 WHERE id = ?")
    .bind(code, linkId)
    .run();
  return { ok: true, code };
}

// Ends a collaboration (or reopens it): the code stops working in the store
// but is never deleted, so her past orders stay attributed and the commission
// she already earned stays on the books. The link is only marked once the
// store confirms, so a failure leaves the tab honest about it.
export async function setCodeActive(
  linkId: number,
  active: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const link = await db()
    .prepare("SELECT discount_code FROM collab_links WHERE id = ?")
    .bind(linkId)
    .first<{ discount_code: string }>();
  if (!link?.discount_code) return { ok: false, error: "no code" };
  const stub = agentStub();
  if (!stub) return { ok: false, error: "agent unavailable" };
  try {
    const res = await stub.fetch("https://agent/collab-discount-active", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: link.discount_code, active }),
    });
    const data = (await res.json()) as { ok: boolean; error?: string };
    if (!data.ok) return { ok: false, error: data.error ?? "unknown" };
  } catch (error) {
    return { ok: false, error: String(error).slice(0, 200) };
  }
  await db()
    .prepare("UPDATE collab_links SET code_ended_at = ? WHERE id = ?")
    .bind(active ? "" : new Date().toISOString().slice(0, 10), linkId)
    .run();
  return { ok: true };
}

// Repair for codes minted without store "combinations": a cart holding an
// automatic discount either refused the code or lost the better automatic
// price. One call per code, and the link is only marked fixed once the store
// confirms it.
export async function fixCodeCombinations(
  linkId?: number,
): Promise<{ ok: boolean; fixed: number; failed: string[] }> {
  const rows = await db()
    .prepare(
      `SELECT id, discount_code FROM collab_links
       WHERE discount_code <> '' AND combines_ok = 0${linkId ? " AND id = ?" : ""}`,
    )
    .bind(...(linkId ? [linkId] : []))
    .all<{ id: number; discount_code: string }>();
  const stub = agentStub();
  if (!stub) return { ok: false, fixed: 0, failed: ["agent unavailable"] };
  let fixed = 0;
  const failed: string[] = [];
  for (const row of rows.results ?? []) {
    try {
      const res = await stub.fetch("https://agent/collab-discount-combine", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: row.discount_code }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!data.ok) {
        failed.push(`${row.discount_code}: ${data.error ?? "unknown"}`);
        continue;
      }
      await db()
        .prepare("UPDATE collab_links SET combines_ok = 1 WHERE id = ?")
        .bind(row.id)
        .run();
      fixed++;
    } catch (error) {
      failed.push(`${row.discount_code}: ${String(error).slice(0, 120)}`);
    }
  }
  return { ok: failed.length === 0, fixed, failed };
}

export async function deleteLink(id: number): Promise<void> {
  const link = await db()
    .prepare("SELECT discount_code FROM collab_links WHERE id = ?")
    .bind(id)
    .first<{ discount_code: string }>();
  await db().prepare("DELETE FROM collab_links WHERE id = ?").bind(id).run();
  await db().prepare("UPDATE collab_prospects SET link_id = NULL WHERE link_id = ?").bind(id).run();
  if (link?.discount_code) await deleteShopifyCode(link.discount_code);
}

// Best-effort store cleanup — a failed delete never blocks the link removal.
export async function deleteShopifyCode(
  code: string,
): Promise<{ ok: boolean; error?: string }> {
  const stub = agentStub();
  if (!stub) return { ok: false, error: "agent unavailable" };
  try {
    const res = await stub.fetch("https://agent/collab-discount-delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    return (await res.json()) as { ok: boolean; error?: string };
  } catch (error) {
    return { ok: false, error: String(error).slice(0, 200) };
  }
}

// ---- Her stats page (/my/<token>) ----
//
// Her clicks, orders and commission, read with the same unguessable token as
// her invite page. Only personal links with a minted code qualify — a generic
// QR link aggregates strangers and has no commission to show.
export type MySale = { order_name: string; total: number; created_at: string };

export async function myStats(token: string): Promise<{
  link: CollabLink;
  sales: MySale[];
} | null> {
  const link = await db()
    .prepare("SELECT * FROM collab_links WHERE token = ?")
    .bind(token)
    .first<CollabLink>();
  if (!link || link.is_generic || !link.discount_code) return null;
  const sales = await db()
    .prepare(
      "SELECT order_name, total, created_at FROM collab_sales WHERE link_id = ? ORDER BY id DESC LIMIT 100",
    )
    .bind(link.id)
    .all<MySale>();
  return { link, sales: sales.results ?? [] };
}

// ---- Admin data for the tab ----

export async function adminData(): Promise<{
  campaign: CollabCampaign;
  products: CollabProduct[];
  links: CollabLink[];
  signups: CollabSignup[];
  prospects: CollabProspect[];
}> {
  const campaign = await ensureCampaign();
  const products = await campaignProducts(campaign.id);
  const links = await db()
    .prepare(
      `SELECT l.*,
              (SELECT COUNT(*) FROM collab_signups s WHERE s.link_id = l.id) AS signups,
              (SELECT COUNT(*) FROM collab_sales cs WHERE cs.link_id = l.id) AS sales_count,
              (SELECT COALESCE(SUM(cs.total),0) FROM collab_sales cs WHERE cs.link_id = l.id) AS sales_total
       FROM collab_links l WHERE l.campaign_id = ? ORDER BY l.id DESC`,
    )
    .bind(campaign.id)
    .all<CollabLink>();
  const signups = await db()
    .prepare("SELECT * FROM collab_signups WHERE campaign_id = ? ORDER BY id DESC")
    .bind(campaign.id)
    .all<CollabSignup>();
  const prospects = await listProspects();
  return {
    campaign,
    products,
    links: links.results ?? [],
    signups: signups.results ?? [],
    prospects,
  };
}

// ---- Signups ----

export type SignupInput = {
  full_name: string;
  instagram: string;
  phone: string;
  email: string;
  size: string;
  color: string;
  address: string;
  city: string;
  apt: string;
  floor: string;
  is_private: number;
  product_id: number;
  item_id: number;
  items: { id: number; size: string }[];
};

function clean(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

export function parseSignup(body: Record<string, unknown>): SignupInput | null {
  const input: SignupInput = {
    full_name: clean(body.full_name, 80),
    instagram: clean(body.instagram, 80).replace(/^@/, ""),
    phone: clean(body.phone, 30),
    email: clean(body.email, 120),
    size: clean(body.size, 8),
    color: clean(body.color, 20),
    // street + house number are composed into one address line for shipping
    address: `${clean(body.street, 120)} ${clean(body.house, 20)}`.trim(),
    city: clean(body.city, 80),
    apt: clean(body.apt, 20),
    floor: clean(body.floor, 20),
    is_private: body.is_private === true || body.is_private === 1 ? 1 : 0,
    product_id: Number(body.product_id) || 0,
    item_id: Number(body.item_id) || 0,
    items: Array.isArray(body.items)
      ? (body.items as Record<string, unknown>[])
          .map((it) => ({ id: Number(it?.id) || 0, size: clean(it?.size, 8) }))
          .filter((it) => it.id > 0)
          .slice(0, 3)
      : [],
  };
  if (!input.full_name || !input.phone || !input.address || !input.city) return null;
  return input;
}

const GENERIC_DAILY_CAP = 60;

export async function addSignup(
  token: string,
  input: SignupInput,
): Promise<{ ok: true } | { ok: false; code: string }> {
  const found = await linkByToken(token);
  if (!found) return { ok: false, code: "bad_token" };
  // One signup per personal link — a resubmit updates nothing, it just tells
  // the sender she is already in (the page shows the success state anyway).
  // A generic QR link takes many signups; there the fence is the same phone
  // signing up twice.
  const existing = found.link.is_generic
    ? await db()
        .prepare("SELECT id FROM collab_signups WHERE link_id = ? AND phone = ? LIMIT 1")
        .bind(found.link.id, input.phone)
        .first<{ id: number }>()
    : await db()
        .prepare("SELECT id FROM collab_signups WHERE link_id = ? LIMIT 1")
        .bind(found.link.id)
        .first<{ id: number }>();
  if (existing) return { ok: true };
  // A generic (QR) link takes many signups, but not thousands: past the
  // daily cap the page keeps its success screen while nothing is written,
  // so a script can't flood the CRM or scroll the partners' chat away.
  if (found.link.is_generic) {
    const today = await db()
      .prepare(
        "SELECT COUNT(*) AS n FROM collab_signups WHERE link_id = ? AND created_at > datetime('now', '-1 day')",
      )
      .bind(found.link.id)
      .first<{ n: number }>();
    if ((today?.n ?? 0) >= GENERIC_DAILY_CAP) return { ok: true };
  }
  let productName = found.product.name;
  let itemId = 0;
  let itemsJson = "";
  if (found.link.product_id == null) {
    // Multi-pick: keep only real offers, capped at the link's allowance.
    const picked = (input.items.length ? input.items : [{ id: input.item_id, size: input.size }])
      .map((it) => {
        const offer = found.offers.find((o) => o.id === it.id);
        return offer ? { id: offer.id, name: offer.name, size: it.size } : null;
      })
      .filter((x): x is { id: number; name: string; size: string } => x !== null)
      .slice(0, Math.max(1, found.link.picks || 1));
    if (picked.length) {
      productName = picked.map((p) => p.name).join(" + ");
      itemId = picked[0].id;
      input.size = picked.map((p) => p.size || "-").join(" / ");
      if (picked.length > 1) itemsJson = JSON.stringify(picked);
    }
  }
  await db()
    .prepare(
      `INSERT INTO collab_signups
       (link_id, campaign_id, full_name, instagram, phone, email, size, color, product, item_id, items, address, city, apt, floor, is_private, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    )
    .bind(
      found.link.id,
      found.campaign.id,
      input.full_name,
      input.instagram,
      input.phone,
      input.email,
      input.size,
      input.color,
      productName,
      itemId,
      itemsJson,
      input.address,
      input.city,
      input.apt,
      input.floor,
      input.is_private,
    )
    .run();
  // A link created by hand often has no handle. She just typed hers, so the
  // link adopts it: the tab row gets a clickable @, and the code she is
  // minted later reads like her account instead of a transliterated name.
  if (!found.link.is_generic && !found.link.instagram && input.instagram) {
    await db()
      .prepare("UPDATE collab_links SET instagram = ? WHERE id = ? AND instagram = ''")
      .bind(input.instagram.replace(/^@/, "").trim(), found.link.id)
      .run();
  }
  await notifyBoard(
    `🤝 ${input.full_name} (@${input.instagram || "?"}) נרשמה לקמפיין המשפיענים!\n` +
      `מוצר: ${productName}\n` +
      `מידה ${input.size || "?"}${input.color ? " · צבע " + input.color : ""} · ${input.address}${input.is_private ? " (בית פרטי)" : `${input.floor ? " קומה " + input.floor : ""}${input.apt ? " דירה " + input.apt : ""}`}, ${input.city}\n` +
      `ווצאפ: ${input.phone} — ⏳ ממתינה לאישור שלכן בטאב 🤝 משפיענים`,
  );
  return { ok: true };
}

export async function updateSignupStatus(id: number, status: string): Promise<boolean> {
  if (!(SIGNUP_STATUSES as readonly string[]).includes(status)) return false;
  await db()
    .prepare("UPDATE collab_signups SET status = ?, status_at = datetime('now') WHERE id = ?")
    .bind(status, id)
    .run();
  if (status === "sent") await autoLogGift(id);
  if (status === "signed") await autoCreateCode(id);
  return true;
}

// The partners approved her — that's when her store code gets minted
// (rejected/pending signups never leave a code behind in the store).
async function autoCreateCode(signupId: number): Promise<void> {
  const su = await db()
    .prepare("SELECT link_id, full_name FROM collab_signups WHERE id = ?")
    .bind(signupId)
    .first<{ link_id: number | null; full_name: string }>();
  if (!su?.link_id) return;
  const existing = await db()
    .prepare("SELECT discount_code FROM collab_links WHERE id = ?")
    .bind(su.link_id)
    .first<{ discount_code: string }>();
  if (existing?.discount_code) return;
  const res = await ensureDiscountCode(su.link_id);
  if (res.ok && res.code) {
    const s = await collabSettings();
    await notifyBoard(
      `🏷️ ${su.full_name} אושרה — נוצר לה קוד ${res.code}.\n` +
        `לינק המכירה שלה (לשלוח אחרי שתפרסם): ${saleURL(s, res.code)}`,
    );
  } else {
    await notifyBoard(
      `⚠️ ${su.full_name} אושרה אבל יצירת הקוד נכשלה (${res.error ?? "?"}) — נסו את כפתור היצירה בטאב.`,
    );
  }
}

// First time a signup is marked shipped, mirror it into the stock module as
// a gift (which also decrements stock at the configured location). Runs once
// per signup — cycling the status pill back through 'sent' won't double-log.
async function autoLogGift(signupId: number): Promise<void> {
  const su = await db()
    .prepare("SELECT * FROM collab_signups WHERE id = ?")
    .bind(signupId)
    .first<CollabSignup>();
  if (!su || su.gift_logged) return;
  const settings = await collabSettings();
  const location = settings.giftLocation;
  const today = new Date().toISOString().slice(0, 10);
  // Multi-pick signups log one gift per picked item.
  let picked: { id: number; name: string; size: string }[] = [];
  try {
    const parsed = su.items ? JSON.parse(su.items) : [];
    if (Array.isArray(parsed)) picked = parsed;
  } catch {
    picked = [];
  }
  if (picked.length <= 1) {
    if (!su.item_id) {
      await notifyBoard(
        `⚠️ סימנתן "נשלח מוצר" ל${su.full_name}, אבל אין פריט מלאי מזוהה (${su.product}${su.color ? " · " + su.color : ""}) — תרשמו את המתנה ידנית במלאי.`,
      );
      return;
    }
    picked = [{ id: su.item_id, name: su.product, size: su.size }];
  }
  const labels: string[] = [];
  let stockLeft: number | null = null;
  for (const it of picked) {
    let res: { label: string; stockLeft: number } | null = null;
    try {
      res = await addGift({
        itemId: it.id,
        person: su.full_name,
        handle: su.instagram,
        kind: "influencer",
        qty: 1,
        size: it.size || "",
        location,
        status: "given",
        note: "נרשם אוטומטית מקמפיין המשפיענים",
        givenAt: today,
      });
    } catch {
      res = null;
    }
    if (res) {
      labels.push(res.label + (it.size ? ` ${it.size}` : ""));
      stockLeft = res.stockLeft;
    }
  }
  if (!labels.length) {
    await notifyBoard(
      `⚠️ סימנתן "נשלח מוצר" ל${su.full_name}, אבל רישום המתנה במלאי נכשל (${su.product}) — תרשמו אותה ידנית.`,
    );
    return;
  }
  await db()
    .prepare("UPDATE collab_signups SET gift_logged = 1 WHERE id = ?")
    .bind(signupId)
    .run();
  await notifyBoard(
    `🎁 המשלוח ל${su.full_name} נרשם אוטומטית במלאי (${labels.join(" + ")}) והמלאי ירד אצל ${location === "lior" ? "ליאור" : "אביה"}.` +
      (labels.length === 1 && stockLeft != null ? ` נשארו ${stockLeft}.` : ""),
  );
}

export async function deleteSignup(id: number): Promise<void> {
  await db().prepare("DELETE FROM collab_signups WHERE id = ?").bind(id).run();
}

export async function setFileReceived(signupId: number, value: boolean): Promise<void> {
  await db()
    .prepare("UPDATE collab_signups SET file_received = ? WHERE id = ?")
    .bind(value ? 1 : 0, signupId)
    .run();
}

// Published reel scorecard fields (tab-edited).
export async function updateReel(
  id: number,
  fields: { reel_url?: string; reel_views?: number },
): Promise<void> {
  const sets: string[] = [];
  const binds: (string | number)[] = [];
  if (typeof fields.reel_url === "string") {
    sets.push("reel_url = ?");
    binds.push(fields.reel_url.trim().slice(0, 300));
  }
  if (typeof fields.reel_views === "number" && Number.isFinite(fields.reel_views)) {
    sets.push("reel_views = ?");
    binds.push(Math.max(0, Math.round(fields.reel_views)));
  }
  if (!sets.length) return;
  binds.push(id);
  await db()
    .prepare(`UPDATE collab_signups SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();
}

// ---- Sales attribution + commission ----

// An order paid with an influencer's personal code = her sale. Called by the
// Shopify order sync with the raw order. The order_key UNIQUE constraint makes
// webhook retries harmless, and the Hobi note gives the partners the
// leaderboard moment in real time. Never throws: attribution must not fail
// the order logging itself.
export async function attributeCollabSale(
  database: D1Database,
  order: {
    id?: number | string;
    total_price?: string | number;
    discount_codes?: { code?: string }[];
  },
  orderNo: string,
): Promise<{ linkId: number; code: string } | null> {
  try {
    const codes = (order.discount_codes ?? [])
      .map((d) => (d.code ?? "").trim().toUpperCase())
      .filter(Boolean);
    if (!codes.length) return null;
    for (const code of codes) {
      const link = await database
        .prepare("SELECT id, name FROM collab_links WHERE UPPER(discount_code) = ?")
        .bind(code)
        .first<{ id: number; name: string }>();
      if (!link) continue;
      const total = Number(order.total_price ?? 0) || 0;
      const res = await database
        .prepare(
          "INSERT OR IGNORE INTO collab_sales (link_id, order_key, order_name, total) VALUES (?, ?, ?, ?)",
        )
        .bind(link.id, String(order.id ?? orderNo), orderNo, total)
        .run();
      if (res.meta.changes > 0) {
        await database
          .prepare(
            "INSERT INTO assistant_chat (chat_id, role, content, kind) VALUES (?, 'assistant', ?, 'note')",
          )
          .bind(
            BOARD_CHAT_ID,
            `💸 מכירה דרך משפיענית! ${link.name} הביאה הזמנה (${orderNo}, ₪${Math.round(total)}) עם הקוד ${code}. הליגה מתעדכנת בטאב 🤝 משפיענים.`,
          )
          .run();
      }
      return { linkId: link.id, code };
    }
    return null;
  } catch {
    return null;
  }
}

// "שולם" on the leaderboard: stamp the paid total at the current accrued
// commission, so the open debt goes to zero and future sales accrue fresh.
export async function markCommissionPaid(linkId: number): Promise<void> {
  const s = await collabSettings();
  await db()
    .prepare(
      `UPDATE collab_links SET commission_paid =
         (SELECT COALESCE(SUM(total),0) * ? FROM collab_sales WHERE link_id = ?)
       WHERE id = ?`,
    )
    .bind(s.commissionPct / 100, linkId, linkId)
    .run();
}

// ---- Hobi's board thread ----
//
// A signup drops a row into Hobi's board thread: the nav badge already polls
// that thread, so the partners get notified with zero new plumbing.
// kind='note' keeps it OUT of the history the model reads — the name and
// address here were typed by a stranger on a public form. Failure here must
// never fail the signup itself.
async function notifyBoard(text: string): Promise<void> {
  try {
    await db()
      .prepare(
        "INSERT INTO assistant_chat (chat_id, role, content, kind) VALUES (?, 'assistant', ?, 'note')",
      )
      .bind(BOARD_CHAT_ID, text.slice(0, 4000))
      .run();
  } catch {
    // The row is already saved; the tab still shows it.
  }
}

// ---- Brief lines and reminders (server.ts calls these on brief mornings) ----

// One compact funnel line for the brief: where the influencer program stands
// right now. Empty when no personal links exist yet.
export async function collabFunnelLine(): Promise<string> {
  try {
    const links = await db()
      .prepare(
        "SELECT COUNT(*) c, SUM(CASE WHEN views > 0 THEN 1 ELSE 0 END) opened FROM collab_links WHERE is_generic = 0",
      )
      .first<{ c: number; opened: number }>();
    if (!links || !links.c) return "";
    const su = await db()
      .prepare(
        `SELECT
           SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) pending,
           SUM(CASE WHEN status IN ('signed','sent','posted','done') THEN 1 ELSE 0 END) approved,
           SUM(CASE WHEN status IN ('posted','done') THEN 1 ELSE 0 END) posted
         FROM collab_signups`,
      )
      .first<{ pending: number; approved: number; posted: number }>();
    const sales = await db()
      .prepare("SELECT COUNT(*) c, COALESCE(SUM(total),0) t FROM collab_sales")
      .first<{ c: number; t: number }>();
    const bits = [`${links.c} לינקים`, `${links.opened ?? 0} נפתחו`];
    if (su?.pending) bits.push(`⏳ ${su.pending} ממתינות לאישור`);
    bits.push(`${su?.approved ?? 0} אושרו`, `${su?.posted ?? 0} פרסמו`);
    if (sales?.c) bits.push(`💸 ${sales.c} מכירות · ₪${Math.round(sales.t)}`);
    return `🤝 משפיענים: ${bits.join(" · ")}`;
  } catch {
    return "";
  }
}

// Stuck states, one digest message. The digest's hash is kept in settings so
// an unchanged situation doesn't repeat every brief.
export async function collabReminders(): Promise<string> {
  const lines: string[] = [];

  const stuckApproved = await db()
    .prepare(
      `SELECT full_name, CAST(julianday('now') - julianday(status_at) AS INTEGER) d
       FROM collab_signups WHERE status = 'signed'
       AND julianday('now') - julianday(status_at) >= 3`,
    )
    .all<{ full_name: string; d: number }>();
  for (const r of stuckApproved.results ?? []) {
    lines.push(`⏰ ${r.full_name} אושרה לפני ${r.d} ימים והמוצר עדיין לא סומן כנשלח`);
  }

  const stuckSent = await db()
    .prepare(
      `SELECT full_name, CAST(julianday('now') - julianday(status_at) AS INTEGER) d
       FROM collab_signups WHERE status = 'sent'
       AND julianday('now') - julianday(status_at) >= 10`,
    )
    .all<{ full_name: string; d: number }>();
  for (const r of stuckSent.results ?? []) {
    lines.push(
      `⏰ ${r.full_name} קיבלה את המוצר לפני ${r.d} ימים ועדיין לא סומנה כפרסמה (ההתחייבות: 10 ימים)`,
    );
  }

  const ghosted = await db()
    .prepare(
      `SELECT name, views FROM collab_links l
       WHERE views > 0
       AND NOT EXISTS (SELECT 1 FROM collab_signups s WHERE s.link_id = l.id)
       AND julianday('now') - julianday(l.created_at) >= 2`,
    )
    .all<{ name: string; views: number }>();
  for (const r of ghosted.results ?? []) {
    lines.push(`👀 ${r.name} פתחה את הלינק (${r.views}×) ולא נרשמה — שווה פולו-אפ`);
  }

  // Outreach follow-ups whose date passed, by the partner who handles them.
  const overdue = await db()
    .prepare(
      `SELECT name, handled_by, followup_date FROM collab_prospects
       WHERE followup_date <> '' AND followup_date <= date('now')
       AND status NOT IN ('done','rejected','linked')
       ORDER BY followup_date`,
    )
    .all<{ name: string; handled_by: string; followup_date: string }>();
  for (const r of overdue.results ?? []) {
    const who = r.handled_by === "avia" ? "אביה" : r.handled_by === "lior" ? "ליאור" : "";
    lines.push(`📆 מעקב אחרי ${r.name} היה אמור לקרות ב-${r.followup_date.slice(8, 10)}/${r.followup_date.slice(5, 7)}${who ? ` (${who})` : ""}`);
  }

  const pendingCount = await db()
    .prepare("SELECT COUNT(*) c FROM collab_signups WHERE status = 'pending'")
    .first<{ c: number }>();
  if ((pendingCount?.c ?? 0) > 0) {
    lines.push(`⏳ ${pendingCount!.c} הרשמות ממתינות לאישור שלכן`);
  }

  if (!lines.length) return "no reminders";
  const digest = `🤝 תזכורות משפיענים:\n${lines.join("\n")}`;

  const hash = await digestHash(digest);
  const last = await db()
    .prepare("SELECT value FROM settings WHERE key = 'collab_reminder_hash'")
    .first<{ value: string }>();
  if (last?.value === hash) return "unchanged, skipped";
  await notifyBoard(digest);
  await db()
    .prepare(
      "INSERT INTO settings (key, value) VALUES ('collab_reminder_hash', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(hash)
    .run();
  return `sent ${lines.length} reminders`;
}

async function digestHash(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const d = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- Outreach prospects (kept by hand) ----

export type CollabProspect = {
  id: number;
  name: string;
  instagram: string;
  followers: number;
  gender: string;
  niche: string;
  note: string;
  personal: string;
  status: string;
  link_id: number | null;
  next_step: string;
  followup_date: string;
  size: string;
  log: string;
  handled_by: string;
  created_at: string;
  updated_at: string;
};

// candidate → to_contact → contacted → talking → agreed → package_sent →
// received → done. linked = a personal link was created; rejected = archive.
export const PROSPECT_STATUSES = [
  "candidate",
  "to_contact",
  "contacted",
  "talking",
  "agreed",
  "package_sent",
  "received",
  "done",
  "linked",
  "rejected",
] as const;

export async function listProspects(): Promise<CollabProspect[]> {
  const res = await db()
    .prepare(
      `SELECT * FROM collab_prospects
       ORDER BY CASE status WHEN 'rejected' THEN 1 ELSE 0 END, followers DESC, id`,
    )
    .all<CollabProspect>();
  return res.results ?? [];
}

export async function addProspect(input: {
  name: string;
  instagram: string;
  followers: number;
  gender: string;
  niche: string;
  note: string;
  handled_by?: string;
}): Promise<{ ok: boolean; duplicate?: boolean; id?: number }> {
  // The archive doubles as a dedupe fence: a handle that was ever added
  // (including archived ones) is never added twice.
  const ig = input.instagram.replace(/^@/, "").trim();
  if (ig) {
    const dup = await db()
      .prepare("SELECT id FROM collab_prospects WHERE LOWER(instagram) = LOWER(?) LIMIT 1")
      .bind(ig)
      .first<{ id: number }>();
    if (dup) return { ok: true, duplicate: true, id: dup.id };
  }
  const res = await db()
    .prepare(
      `INSERT INTO collab_prospects (name, instagram, followers, gender, niche, note, handled_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.name.trim().slice(0, 80),
      ig.slice(0, 80),
      Math.max(0, Math.round(input.followers) || 0),
      input.gender === "m" || input.gender === "f" ? input.gender : "",
      input.niche.trim().slice(0, 60),
      input.note.trim().slice(0, 300),
      handledBy(input.handled_by),
    )
    .run();
  return { ok: true, id: Number(res.meta.last_row_id) };
}

export async function updateProspect(
  id: number,
  fields: {
    name?: string;
    instagram?: string;
    followers?: number;
    gender?: string;
    niche?: string;
    note?: string;
    personal?: string;
    next_step?: string;
    followup_date?: string;
    size?: string;
  },
): Promise<void> {
  const sets: string[] = [];
  const binds: (string | number)[] = [];
  const text = (col: string, v: unknown, max: number) => {
    if (typeof v !== "string") return;
    sets.push(`${col} = ?`);
    binds.push(v.trim().slice(0, max));
  };
  if (typeof fields.name === "string" && fields.name.trim()) text("name", fields.name, 80);
  text("instagram", typeof fields.instagram === "string" ? fields.instagram.replace(/^@/, "") : undefined, 80);
  if (typeof fields.followers === "number" && Number.isFinite(fields.followers)) {
    sets.push("followers = ?");
    binds.push(Math.max(0, Math.round(fields.followers)));
  }
  if (typeof fields.gender === "string") {
    sets.push("gender = ?");
    binds.push(fields.gender === "m" || fields.gender === "f" ? fields.gender : "");
  }
  text("niche", fields.niche, 60);
  text("note", fields.note, 300);
  text("personal", fields.personal, 200);
  text("next_step", fields.next_step, 140);
  if (typeof fields.followup_date === "string") {
    sets.push("followup_date = ?");
    binds.push(/^\d{4}-\d{2}-\d{2}$/.test(fields.followup_date) ? fields.followup_date : "");
  }
  text("size", fields.size, 8);
  if (!sets.length) return;
  sets.push("updated_at = datetime('now')");
  binds.push(id);
  await db()
    .prepare(`UPDATE collab_prospects SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();
}

// Free-text log line ("ענתה, רוצה את הסט הכחול"). Newest last.
export async function addProspectLog(id: number, text: string): Promise<boolean> {
  const t = text.trim().slice(0, 400);
  if (!t) return false;
  const row = await db()
    .prepare("SELECT log FROM collab_prospects WHERE id = ?")
    .bind(id)
    .first<{ log: string }>();
  if (!row) return false;
  let log: { at: string; text: string }[] = [];
  try {
    const parsed = JSON.parse(row.log || "[]");
    if (Array.isArray(parsed)) log = parsed;
  } catch {
    log = [];
  }
  log.push({ at: new Date().toISOString(), text: t });
  await db()
    .prepare("UPDATE collab_prospects SET log = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(JSON.stringify(log.slice(-200)), id)
    .run();
  return true;
}

export async function updateProspectStatus(id: number, status: string): Promise<boolean> {
  if (!(PROSPECT_STATUSES as readonly string[]).includes(status)) return false;
  await db()
    .prepare("UPDATE collab_prospects SET status = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(status, id)
    .run();
  return true;
}

export async function deleteProspect(id: number): Promise<void> {
  await db().prepare("DELETE FROM collab_prospects WHERE id = ?").bind(id).run();
}

// One click in the tab: prospect → live personal link (stock-choice, 1 pick),
// prospect marked 'linked' and pointed at the link it spawned. The link
// inherits who handles her; the actor fills in when nobody was set.
export async function prospectToLink(
  id: number,
  campaignId: number,
  actor = "",
): Promise<CollabLink | null> {
  const pr = await db()
    .prepare("SELECT * FROM collab_prospects WHERE id = ?")
    .bind(id)
    .first<CollabProspect>();
  if (!pr) return null;
  const link = await createLink(
    campaignId,
    pr.name,
    pr.instagram,
    null,
    1,
    pr.personal,
    false,
    pr.gender,
    pr.handled_by || actor,
  );
  await db()
    .prepare("UPDATE collab_prospects SET status = 'linked', link_id = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(link.id, id)
    .run();
  return link;
}
