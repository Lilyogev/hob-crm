import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type DragEvent, type KeyboardEvent } from "react";
import { isDemo } from "../demo";

import {
  DeleteButton,
  Dropdown,
  EditableText,
  PillCell,
  api,
  formatHebDate,
  menuPosFor,
  parseMoney,
  post,
  todayISO,
  type MenuPos,
} from "../board";
// Shekel amounts. In demo mode (🥷) body.hob-demo CSS smears every .dm span.

export const ILS = (n: number) => (isDemo() ? "₪•••" : `₪${Math.round(n).toLocaleString("en-US")}`);
export const Shs = (n: number) => <span className="dm">{ILS(n)}</span>;

// ---- Types (mirror of /api/seeding) ----

type StockRow = {
  location: string;
  qty: number;
  qty_xs: number;
  qty_s: number;
  qty_m: number;
  qty_l: number;
  qty_xl: number;
  qty_xxl: number;
};

export type SeedItem = {
  id: number;
  name: string;
  size: string;
  price: number;
  collection: string;
  given: number;
  sold: number;
  updated_at: string;
  stock: StockRow[];
};

// Collections split the stock screen: the live drop is counted apart from
// previous-drop leftovers and side products, because "how much is left" only
// means something per collection. Order here is the order on screen.
export const COLLECTIONS = [
  { key: "drop4", label: "דרופ 4 · כדורגל", short: "דרופ 4", color: "#00854d" },
  { key: "drop3", label: "דרופ 3 · DREAMERS COLLECTIVE", short: "דרופ 3", color: "#0073ea" },
  { key: "prev", label: "דרופים קודמים", short: "קודמים", color: "#a25ddc" },
  { key: "side", label: "אחר · צד", short: "אחר", color: "#676879" },
] as const;

export function itemCollection(i: SeedItem): string {
  return COLLECTIONS.some((c) => c.key === i.collection) ? i.collection : "drop3";
}

// Stock is a size matrix per LOCATION: the item row shows summed totals, the
// expanded rows show each location's buckets. Order matches the table columns.
export const BUCKETS = [
  { col: "qty", label: "בלי מידה" },
  { col: "qty_xs", label: "XS" },
  { col: "qty_s", label: "S" },
  { col: "qty_m", label: "M" },
  { col: "qty_l", label: "L" },
  { col: "qty_xl", label: "XL" },
  { col: "qty_xxl", label: "XXL" },
] as const;

export const LOCATIONS = [
  { key: "room", label: "חדר", icon: "🏠" },
  { key: "car", label: "אוטו של יוגב", icon: "🚗" },
  { key: "stores", label: "אצל חנויות", icon: "🏬" },
] as const;

// "אצל דימה" closed on 27.9.2026 (the business is Yogev's; its stock moved to the room).
// Kept only as a label so old rows still read correctly.
const LOC_META: Record<string, { label: string; icon: string }> = {
  ...Object.fromEntries(LOCATIONS.map((l) => [l.key, { label: l.label, icon: l.icon }])),
  dima: { label: "אצל דימה (נסגר)", icon: "📦" },
};

const EMPTY_ROW = { qty: 0, qty_xs: 0, qty_s: 0, qty_m: 0, qty_l: 0, qty_xl: 0, qty_xxl: 0 };

export function stockAt(i: SeedItem, loc: string): StockRow {
  return i.stock.find((r) => r.location === loc) ?? { location: loc, ...EMPTY_ROW };
}

export function rowTotal(r: { qty: number; qty_xs: number; qty_s: number; qty_m: number; qty_l: number; qty_xl: number; qty_xxl: number }): number {
  return r.qty + r.qty_xs + r.qty_s + r.qty_m + r.qty_l + r.qty_xl + r.qty_xxl;
}

export function bucketSum(i: SeedItem, col: (typeof BUCKETS)[number]["col"]): number {
  return i.stock.reduce((s, r) => s + r[col], 0);
}

export function itemTotal(i: SeedItem): number {
  return i.stock.reduce((s, r) => s + rowTotal(r), 0);
}

export type SeedGift = {
  id: number;
  item_id: number | null;
  item_label: string;
  person: string;
  handle: string;
  kind: string;
  qty: number;
  size: string;
  location: string;
  status: string;
  note: string;
  given_at: string;
  position: number;
  updated_at: string;
};

export type SeedSale = {
  id: number;
  item_id: number | null;
  item_label: string;
  buyer: string;
  buyer_phone: string;
  buyer_email: string;
  buyer_address: string;
  qty: number;
  size: string;
  location: string;
  price: number;
  ship_status: string;
  pay_method: string;
  channel: string;
  note: string;
  sold_at: string;
  position: number;
  updated_at: string;
};

export type SeedingData = { ok: boolean; items: SeedItem[]; gifts: SeedGift[]; sales: SeedSale[] };

// One line of a multi-item gift/sale being composed (price is per unit, ₪;
// size is the size taken — inventory rows are per-color totals).
type Line = { itemId: number; qty: number; size: string; price: number };

// ---- Vocabulary (same Monday palette as the task board) ----

export const KIND: Record<string, { label: string; bg: string; fg: string }> = {
  influencer: { label: "משפיען", bg: "#a25ddc", fg: "#ffffff" },
  friend: { label: "חבר", bg: "#579bfc", fg: "#ffffff" },
  other: { label: "אחר", bg: "#8e8e8e", fg: "#ffffff" }, // האפור של סגולה (יוגב, 28.9)
};
const KIND_ORDER = ["influencer", "friend", "other"];

// Custom kinds ("צלם", "מייסד", "דוגמנית"...) keep their own label but share
// the "אחר" color (Yogev, 28.9): only influencers and friends stand out, and the
// rows still group by kind so each custom kind sits together.

// A kind typed by hand as a preset's label ("משפיען") is that preset.
export function normalizeKind(kind: string): string {
  const k = kind.trim();
  if (KIND[k]) return k;
  const preset = Object.entries(KIND).find(([, v]) => v.label === k);
  return preset ? preset[0] : k;
}

export function kindStyle(kind: string): { label: string; bg: string; fg: string } {
  const k = normalizeKind(kind);
  if (KIND[k]) return KIND[k];
  if (!k) return KIND.other;
  return { label: k, bg: KIND.other.bg, fg: KIND.other.fg };
}

// Gift rows group by kind so each color sits together: influencers first,
// then friends, then custom kinds (A→Z), "אחר" last.
export function compareKinds(a: string, b: string): number {
  const rank = (k: string) =>
    k === "influencer" ? 0 : k === "friend" ? 1 : k === "other" || !k ? 3 : 2;
  const ka = normalizeKind(a);
  const kb = normalizeKind(b);
  return rank(ka) - rank(kb) || ka.localeCompare(kb, "he");
}

export const GIFT_STATUS: Record<string, { label: string; bg: string; fg: string }> = {
  promised: { label: "הובטח", bg: "#fdab3d", fg: "#ffffff" },
  given: { label: "נמסר", bg: "#00c875", fg: "#ffffff" },
  story: { label: "העלה סטורי", bg: "#a25ddc", fg: "#ffffff" },
  posted: { label: "פרסם פוסט", bg: "#0073ea", fg: "#ffffff" },
};
export const GIFT_STATUS_ORDER = ["promised", "given", "story", "posted"];

// Same idea as SHIP_RANK below: rows sort themselves by how far along they are,
// so clicking "העלה סטורי" drops the row next to the others that posted a story
// instead of leaving it wherever it was dragged.
export const GIFT_RANK: Record<string, number> = { promised: 0, given: 1, story: 2, posted: 3 };

export const SHIP_STATUS: Record<string, { label: string; bg: string; fg: string }> = {
  recorded: { label: "נרשם", bg: "#c4c4c4", fg: "#ffffff" },
  packed: { label: "אריזה מוכנה", bg: "#fdab3d", fg: "#ffffff" },
  shipped: { label: "משלוח יצא", bg: "#579bfc", fg: "#ffffff" },
  delivered: { label: "התקבל ✓", bg: "#00c875", fg: "#ffffff" },
  // Cancelled rows stay visible (the ledger must keep reconciling against
  // Shopify) but drop out of every money/stock number and sink to the bottom.
  cancelled: { label: "בוטל", bg: "#e2445c", fg: "#ffffff" },
};
export const SHIP_STATUS_ORDER = ["recorded", "packed", "shipped", "delivered", "cancelled"];

// Fulfillment sort: active orders float to the top, delivered sink to the
// bottom — clicking "התקבל" moves the row down automatically.
export const SHIP_RANK: Record<string, number> = {
  recorded: 0,
  packed: 1,
  shipped: 2,
  delivered: 3,
  cancelled: 4,
};

// Where the money landed. Store orders tag themselves; the rare face-to-face
// sale gets tagged by hand. "" stays a real option — an untagged row is not an
// error, just money nobody has attributed yet.
export const PAY_METHOD: Record<string, { label: string; bg: string; fg: string }> = {
  "": { label: "לא סומן", bg: "#c4c4c4", fg: "#ffffff" },
  shopify: { label: "🛍 שופיפיי", bg: "#0073ea", fg: "#ffffff" },
  hyp: { label: "💳 Hyp", bg: "#14142b", fg: "#ffffff" },
  bit: { label: "📱 ביט", bg: "#a25ddc", fg: "#ffffff" },
  cash: { label: "💵 מזומן", bg: "#00c875", fg: "#ffffff" },
  transfer: { label: "🏦 העברה", bg: "#fdab3d", fg: "#ffffff" },
};
export const PAY_METHOD_ORDER = ["", "shopify", "hyp", "bit", "cash", "transfer"];

export const ITEM_COLOR = "#0073ea";
export const GIFT_COLOR = "#a25ddc";
export const SALE_COLOR = "#00854d";

// ---- Small helpers ----

export function itemLabel(i: SeedItem): string {
  return i.size ? `${i.name} (${i.size})` : i.name;
}

// The 👤 panel: the buyer's contact details, edited in place. Saved as shared
// fields onto all the buyer's sale lines (same semantics as the buyer name).
// All values carry .dm so demo mode blurs customer data too.
export function hasContact(s: SeedSale): boolean {
  return Boolean(s.buyer_phone || s.buyer_email || s.buyer_address);
}

// Who a sale belongs to, for grouping the log by buyer. The name is
// disambiguated by a contact detail so two different "דנה"s stay two rows.
// The same phone typed two ways (0544405041 from the store, +972544405041
// from another order, 054-440-5041 by hand) is one number: compare digits,
// with Israel's 972 prefix read as the local 0 (29.9: Ariel Katzman's two
// orders split on exactly this). Emails compare case-insensitively.
export function contactKey(phone?: string, email?: string): string {
  const digits = (phone ?? "").replace(/\D/g, "");
  const local = digits.startsWith("972") ? `0${digits.slice(3)}` : digits;
  if (local.length >= 9) return local;
  return (email ?? "").trim().toLowerCase();
}

export function saleGroupKey(s: SeedSale, popupBuyer: string): string {
  const name = s.buyer.trim();
  // Anonymous pop-up sales are never grouped: each line is its own row.
  if (!name || name === popupBuyer) return `#${s.id}`;
  return `${name.toLowerCase()}|${contactKey(s.buyer_phone, s.buyer_email)}`;
}

// wa.me link for an Israeli number ("054-5414000" → 972545414000). Null when
// the value doesn't look like a dialable phone — then no button is shown.
function waHref(phone: string): string | null {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 9) return null;
  const intl = digits.startsWith("972")
    ? digits
    : digits.startsWith("0")
      ? `972${digits.slice(1)}`
      : digits;
  return `https://wa.me/${intl}`;
}

// Repeat buyer = purchases on more than one date (lines of one multi-item
// order share their sold_at, so a single haul doesn't count as two).
function buyDates(rows: SeedSale[]): number {
  return new Set(rows.map((r) => r.sold_at).filter(Boolean)).size;
}

// Group divider above each collection's items, with that collection's own
// three numbers — the whole point of the split is that each drop answers
// "how much is left" for itself.
export function CollectionHeader({
  label,
  color,
  inStock,
}: {
  label: string;
  color: string;
  inStock: number;
}) {
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium"
      style={{ backgroundColor: `${color}14`, color }}
    >
      <span>{label}</span>
      <span className="dm text-[12px]">{inStock} במלאי</span>
    </div>
  );
}

// Moving an item between collections — the only edit that needs a fixed set
// of options, so it stays a plain select instead of the inline-text pattern.
export function CollectionPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      title="הקולקציה שהפריט שייך אליה"
      className="rounded-md border border-[var(--hob-rule)] bg-[var(--hob-surface)] px-1.5 py-0.5 text-[11.5px] text-[var(--hob-soft)] hover:border-[var(--hob-faint)] focus:border-[var(--hob-accent)] focus:outline-none"
    >
      {COLLECTIONS.map((c) => (
        <option key={c.key} value={c.key}>
          {c.label}
        </option>
      ))}
    </select>
  );
}

export function RepeatBadge({ rows }: { rows: SeedSale[] }) {
  const n = buyDates(rows);
  if (n < 2) return null;
  return (
    <span
      title={`קנה ב-${n} תאריכים שונים — לקוח חוזר`}
      className="shrink-0 rounded-full bg-[#00c875]/15 px-1.5 py-0.5 text-[10.5px] font-bold text-[var(--hob-good)]"
    >
      חוזר ×{n}
    </span>
  );
}

// Editable group total (the סה"כ column). Typing a new total — a package
// discount — rescales every line's unit price pro-rata so the lines still sum
// to exactly what the customer paid; a single line is simply a price edit.
export function GroupTotalEdit({
  rows,
  act,
}: {
  rows: SeedSale[];
  act: (body: Record<string, unknown>) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const total = rows.reduce((s, r) => s + r.price * r.qty, 0);
  const save = () => {
    setEditing(false);
    const n = parseFloat(draft.replace(/[^\d.]/g, ""));
    if (!isFinite(n) || n < 0 || total <= 0 || Math.round(n) === Math.round(total)) return;
    let remaining = n;
    rows.forEach((r, i) => {
      const lineTarget =
        i === rows.length - 1 ? remaining : Math.round(((r.price * r.qty) / total) * n);
      remaining -= lineTarget;
      const unit = Math.round((lineTarget / Math.max(1, r.qty)) * 100) / 100;
      act({ action: "sale_update", id: r.id, patch: { price: unit } });
    });
  };
  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        inputMode="numeric"
        dir="ltr"
        className="dm w-20 rounded-md border border-[var(--hob-accent)] px-1.5 py-0.5 text-center text-[13px] font-semibold outline-none"
      />
    );
  }
  return (
    <button
      type="button"
      onClick={() => {
        setDraft(String(Math.round(total)));
        setEditing(true);
      }}
      title={rows.length > 1 ? "לחיצה — עריכת הסה״כ (הנחה); הסכום מתחלק יחסית בין הפריטים" : "לחיצה — עריכת הסכום"}
      className="font-semibold text-[var(--hob-good)] underline decoration-dotted underline-offset-2"
    >
      {Shs(total)}
    </button>
  );
}

// 🎪 next to buyers whose purchase came through the pop-up quick-sale screen.
export function PopupBadge({ rows }: { rows: SeedSale[] }) {
  if (!rows.some((r) => r.channel === "popup")) return null;
  return (
    <span
      title="קנייה בפופ-אפ"
      className="shrink-0 rounded-full bg-[#fdab3d]/20 px-1.5 py-0.5 text-[10.5px] font-bold text-[#fdab3d] ivory:text-[#b45309]"
    >
      🎪 פופ-אפ
    </span>
  );
}

// The collapsible "דרופים קודמים" divider at the bottom of the sales log.
// Collapsed (the default) hides every archive-only buyer behind one line;
// open shows them in the regular format. variant matches the host view.
export function ArchiveToggle({
  count,
  open,
  onToggle,
  variant,
}: {
  count: number;
  open: boolean;
  onToggle: () => void;
  variant: "card" | "row";
}) {
  const label = (
    <>
      <span className={`inline-block text-[10px] transition-transform ${open ? "" : "-rotate-90"}`}>
        ▾
      </span>
      <span className="font-bold">🗂 דרופים קודמים</span>
      <span className="dm text-[var(--hob-faint)]">· {count} לקוחות</span>
      <span className="text-[11px] font-normal text-[var(--hob-faint)]">
        {open ? "לחיצה מסתירה" : "לחיצה מציגה"}
      </span>
    </>
  );
  if (variant === "card") {
    return (
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 rounded-lg border border-[var(--hob-rule)] bg-[var(--hob-bg2)] p-2.5 text-[13px] text-[var(--hob-soft)] shadow-sm"
        style={{ borderInlineStart: "5px solid #c3c6d4" }}
      >
        {label}
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center gap-2 border-b border-[var(--hob-rule)] bg-[var(--hob-bg2)] px-4 py-2 text-[13px] text-[var(--hob-soft)] last:border-b-0 hover:bg-[var(--hob-hover)]"
      style={{ borderInlineStart: "5px solid #c3c6d4" }}
    >
      {label}
    </button>
  );
}

export function CustomerDetails({
  first,
  ids,
  act,
  wide,
  rows,
}: {
  first: SeedSale;
  ids: number[];
  act: (body: Record<string, unknown>) => void;
  // wide = a full-width strip under the desktop row, fields side by side —
  // the buyer column is too narrow to show an email or address untruncated.
  wide?: boolean;
  // When the group's rows are passed, the panel offers the 🎪 channel toggle
  // (mark/unmark an existing sale as a pop-up sale).
  rows?: SeedSale[];
}) {
  const editable = (rows ?? []).filter((r) => r.channel !== "archive");
  const isPopup = editable.some((r) => r.channel === "popup");
  const popupToggle =
    editable.length > 0 ? (
      <button
        type="button"
        onClick={() =>
          act({
            action: "sale_update",
            ids: editable.map((r) => r.id),
            patch: { channel: isPopup ? "" : "popup" },
          })
        }
        title={isPopup ? "הסרת סימון פופ-אפ מהקנייה" : "סימון הקנייה כקניית פופ-אפ"}
        className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${
          isPopup ? "bg-[#fdab3d]/20 text-[#fdab3d] ivory:text-[#b45309]" : "bg-[var(--hob-hover)] text-[var(--hob-soft)] hover:bg-[var(--hob-rule)]"
        }`}
      >
        {isPopup ? "🎪 פופ-אפ ✓ · ביטול" : "🎪 סמן כפופ-אפ"}
      </button>
    ) : null;
  const fields = [
    { key: "buyer_phone", icon: "📞", placeholder: "＋ טלפון", value: first.buyer_phone },
    { key: "buyer_email", icon: "✉️", placeholder: "＋ אימייל", value: first.buyer_email },
    { key: "buyer_address", icon: "📍", placeholder: "＋ כתובת משלוח", value: first.buyer_address },
  ] as const;
  const line = (f: (typeof fields)[number]) => {
    const wa = f.key === "buyer_phone" && f.value ? waHref(f.value) : null;
    return (
      <div
        key={f.key}
        className={`flex items-center gap-1 text-[12px] text-[var(--hob-soft)] ${
          wide ? "min-w-52 flex-1" : "ps-3"
        }`}
        title={f.value || undefined}
      >
        <span className="shrink-0">{f.icon}</span>
        <EditableText
          value={f.value || ""}
          placeholder={f.placeholder}
          className="dm rounded-md text-[12px] text-[var(--hob-soft)]"
          onSave={(v) => act({ action: "sale_update", ids, patch: { [f.key]: v } })}
        />
        {wa && (
          <a
            href={wa}
            target="_blank"
            rel="noreferrer"
            title="פתיחת וואטסאפ עם הלקוח"
            className="shrink-0 rounded-full bg-[#00c875]/15 px-2 py-0.5 text-[11px] font-bold text-[var(--hob-good)] hover:bg-[#00c875]/25"
          >
            💬 וואטסאפ
          </a>
        )}
      </div>
    );
  };
  if (wide) {
    return (
      <div
        className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[var(--hob-hover)] bg-[var(--hob-bg2)] py-0.5 pe-3 ps-8"
        style={{ borderInlineStart: "5px solid #e6e9f2" }}
      >
        {fields.map(line)}
        {popupToggle}
      </div>
    );
  }
  return (
    <div className="pb-1">
      {fields.map(line)}
      {popupToggle && <div className="mt-1 ps-3">{popupToggle}</div>}
    </div>
  );
}

export function QtyStepper({
  value,
  danger,
  onChange,
}: {
  value: number;
  danger?: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex h-9 items-center justify-center gap-1" dir="ltr">
      <button
        type="button"
        onClick={() => onChange(value - 1)}
        className="h-7 w-7 rounded-md bg-[var(--hob-hover)] text-base leading-none text-[var(--hob-soft)] hover:bg-[var(--hob-rule)]"
        aria-label="הורדת כמות"
      >
        −
      </button>
      <span
        className={`min-w-8 text-center text-sm font-semibold ${
          danger ? "text-[#e2445c]" : "text-[var(--hob-ink)]"
        }`}
      >
        {value}
      </span>
      <button
        type="button"
        onClick={() => onChange(value + 1)}
        className="h-7 w-7 rounded-md bg-[var(--hob-hover)] text-base leading-none text-[var(--hob-soft)] hover:bg-[var(--hob-rule)]"
        aria-label="הוספת כמות"
      >
        +
      </button>
    </div>
  );
}

// Kind pill with the preset options PLUS a free-text field — the partners can
// type their own label ("צלם", "ספק", "משפחה"...). Custom kinds render as a
// dark-gray pill with the typed text.
export function KindCell({
  value,
  rounded,
  onChange,
}: {
  value: string;
  rounded?: boolean;
  onChange: (v: string) => void;
}) {
  const [pos, setPos] = useState<MenuPos | null>(null);
  const [draft, setDraft] = useState("");
  const current = kindStyle(value);
  const commit = () => {
    const v = draft.trim();
    if (!v) return;
    onChange(normalizeKind(v.slice(0, 30)));
    setDraft("");
    setPos(null);
  };
  return (
    <div className="relative h-full w-full">
      <button
        type="button"
        onClick={(e) =>
          setPos((p) => (p ? null : menuPosFor(e.currentTarget, KIND_ORDER.length + 2)))
        }
        className={`flex h-9 w-full items-center justify-center px-1 text-sm font-medium transition-transform active:scale-[0.98] ${rounded ? "rounded-md" : ""}`}
        style={{ backgroundColor: current.bg, color: current.fg }}
      >
        <span className="truncate">{current.label}</span>
      </button>
      <Dropdown pos={pos} onClose={() => setPos(null)}>
        {KIND_ORDER.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => {
              onChange(key);
              setPos(null);
            }}
            className="block w-full px-3 py-2 text-center text-sm font-medium hover:opacity-90"
            style={{ backgroundColor: KIND[key].bg, color: KIND[key].fg }}
          >
            {KIND[key].label}
          </button>
        ))}
        <div className="flex items-center gap-1 border-t border-[var(--hob-rule)] p-1.5">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && commit()}
            placeholder="סוג משלך…"
            className="h-8 w-28 rounded-md border border-[var(--hob-rule-strong)] px-2 text-sm outline-none placeholder:text-[var(--hob-faint)] focus:border-[var(--hob-accent)]"
          />
          <button
            type="button"
            onClick={commit}
            disabled={!draft.trim()}
            className="h-8 rounded-md bg-[var(--hob-accent)] px-2 text-sm font-medium text-white disabled:bg-[var(--hob-faint)]"
          >
            ✓
          </button>
        </div>
      </Dropdown>
    </div>
  );
}

// Location picker for logging — remembers the last choice on this device, so
// out in the field it stays on "car" without re-picking every time.
function lastLocation(): string {
  if (typeof localStorage === "undefined") return "room";
  const saved = localStorage.getItem("hob_loc");
  return LOC_META[saved ?? ""] ? (saved as string) : "room";
}

// The manual form is for sales that did NOT come through the store (store
// orders tag themselves on sync), so it opens on Bit — and remembers whatever
// was picked last on this device.
function lastPayMethod(): string {
  if (typeof localStorage === "undefined") return "bit";
  const saved = localStorage.getItem("hob_pay");
  return saved !== null && PAY_METHOD[saved] ? saved : "bit";
}

function LocPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [pos, setPos] = useState<MenuPos | null>(null);
  const current = LOC_META[value] ?? LOC_META.room;
  return (
    <div className="relative h-9 w-full">
      <button
        type="button"
        onClick={(e) => setPos((p) => (p ? null : menuPosFor(e.currentTarget, LOCATIONS.length)))}
        className="flex h-9 w-full items-center justify-center gap-1 rounded-md border border-[var(--hob-accent)] bg-[var(--hob-surface)] px-2 text-sm font-medium text-[var(--hob-accent)]"
      >
        <span className="truncate">
          {current.icon} {current.label}
        </span>
        <span className="text-[10px]">▾</span>
      </button>
      <Dropdown pos={pos} onClose={() => setPos(null)}>
        {LOCATIONS.map((l) => (
          <button
            key={l.key}
            type="button"
            onClick={() => {
              onChange(l.key);
              try {
                localStorage.setItem("hob_loc", l.key);
              } catch {
                // Private-mode storage errors must not break the picker.
              }
              setPos(null);
            }}
            className={`block w-full px-3 py-2 text-start text-sm hover:bg-[var(--hob-hover)] ${
              l.key === value ? "bg-[var(--hob-hover)] font-semibold text-[var(--hob-accent)]" : "text-[var(--hob-ink)]"
            }`}
          >
            {l.icon} {l.label}
          </button>
        ))}
      </Dropdown>
    </div>
  );
}

// Inline transfer: move qty of one size from one location to another.
export function TransferInline({
  from,
  onTransfer,
}: {
  from: string;
  onTransfer: (to: string, size: string, qty: number) => void;
}) {
  const targets = LOCATIONS.filter((l) => l.key !== from);
  const [to, setTo] = useState(targets[0].key as string);
  const [size, setSize] = useState("");
  const [qty, setQty] = useState(1);
  const [pos, setPos] = useState<MenuPos | null>(null);
  const toMeta = LOC_META[to] ?? LOC_META.room;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[12px] text-[var(--hob-soft)]">
        העברה מ{LOC_META[from]?.label ?? from} אל
      </span>
      <div className="relative">
        <button
          type="button"
          onClick={(e) => setPos((p) => (p ? null : menuPosFor(e.currentTarget, targets.length)))}
          className="flex h-8 items-center gap-1 rounded-md border border-[var(--hob-rule-strong)] bg-[var(--hob-surface)] px-2 text-[13px] text-[var(--hob-ink)]"
        >
          {toMeta.icon} {toMeta.label} <span className="text-[10px] text-[var(--hob-faint)]">▾</span>
        </button>
        <Dropdown pos={pos} onClose={() => setPos(null)}>
          {targets.map((l) => (
            <button
              key={l.key}
              type="button"
              onClick={() => {
                setTo(l.key);
                setPos(null);
              }}
              className="block w-full px-3 py-2 text-start text-sm text-[var(--hob-ink)] hover:bg-[var(--hob-hover)]"
            >
              {l.icon} {l.label}
            </button>
          ))}
        </Dropdown>
      </div>
      <div className="w-20">
        <SizePicker value={size} onChange={setSize} bordered />
      </div>
      <div className="rounded-md border border-[var(--hob-rule-strong)] bg-[var(--hob-surface)]">
        <QtyStepper value={qty} onChange={(v) => setQty(Math.max(1, v))} />
      </div>
      <button
        type="button"
        onClick={() => onTransfer(to, size, qty)}
        className="h-8 rounded-md bg-[var(--hob-accent)] px-3 text-[13px] font-medium text-white hover:bg-[var(--hob-accent-hover)]"
      >
        ⇄ העבר
      </button>
    </div>
  );
}

// One stock-bucket number, edited in place (tap the number, type, Enter).
export function BucketCell({ value, onSave }: { value: number; onSave: (v: number) => void }) {
  return (
    <EditableText
      value={String(value)}
      className={`dm text-center ${
        value < 0
          ? "font-semibold text-[#e2445c]"
          : value === 0
            ? "text-[var(--hob-faint)]"
            : "font-medium"
      }`}
      inputMode="numeric"
      onSave={(v) => {
        const n = parseMoney(v);
        if (Number.isFinite(n)) onSave(Math.trunc(n));
      }}
    />
  );
}

// Quick size picker: one tap, XS–XXL (free typing was too slow in the field).
const SIZES = ["XS", "S", "M", "L", "XL", "XXL"];

export function SizePicker({
  value,
  onChange,
  bordered,
}: {
  value: string;
  onChange: (v: string) => void;
  bordered?: boolean;
}) {
  const [pos, setPos] = useState<MenuPos | null>(null);
  // In the read-only rows (non-bordered) an empty size shows nothing at all
  // instead of a placeholder "מידה" box — no clutter next to size-less items
  // like hats. The entry forms are bordered, so they keep the picker.
  if (!bordered && !value) return null;
  return (
    <div className="relative h-9 w-full">
      <button
        type="button"
        onClick={(e) =>
          setPos((p) => (p ? null : menuPosFor(e.currentTarget, SIZES.length + 1)))
        }
        className={`flex h-9 w-full items-center justify-center gap-1 text-sm ${
          bordered ? "rounded-md border border-[var(--hob-rule-strong)] bg-[var(--hob-surface)]" : "hover:bg-[var(--hob-hover)]"
        } ${value ? "font-medium text-[var(--hob-ink)]" : "text-[var(--hob-faint)]"}`}
      >
        {value || "מידה"}
        <span className="text-[10px] text-[var(--hob-faint)]">▾</span>
      </button>
      <Dropdown pos={pos} onClose={() => setPos(null)}>
        {SIZES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => {
              onChange(s);
              setPos(null);
            }}
            className={`block w-full px-3 py-2 text-center text-sm hover:bg-[var(--hob-hover)] ${
              s === value ? "bg-[var(--hob-hover)] font-semibold text-[var(--hob-accent)]" : "text-[var(--hob-ink)]"
            }`}
          >
            {s}
          </button>
        ))}
        <button
          type="button"
          onClick={() => {
            onChange("");
            setPos(null);
          }}
          className="block w-full border-t border-[var(--hob-rule)] px-3 py-2 text-center text-sm text-[var(--hob-soft)] hover:bg-[var(--hob-hover)]"
        >
          בלי מידה
        </button>
      </Dropdown>
    </div>
  );
}

function ItemPicker({
  items,
  value,
  onChange,
}: {
  items: SeedItem[];
  value: number;
  onChange: (id: number) => void;
}) {
  const [pos, setPos] = useState<MenuPos | null>(null);
  const current = items.find((i) => i.id === value);
  return (
    <div className="relative w-full">
      <button
        type="button"
        onClick={(e) =>
          setPos((p) => (p ? null : menuPosFor(e.currentTarget, Math.min(items.length, 8))))
        }
        className="flex h-9 w-full items-center justify-between rounded-md border border-[var(--hob-rule-strong)] bg-[var(--hob-surface)] px-2 text-sm text-[var(--hob-ink)]"
      >
        <span className="truncate">
          {current ? itemLabel(current) : <span className="text-[var(--hob-faint)]">בחר פריט…</span>}
        </span>
        <span className="text-[var(--hob-faint)]">▾</span>
      </button>
      <Dropdown pos={pos} onClose={() => setPos(null)}>
        {items.map((i) => (
          <button
            key={i.id}
            type="button"
            onClick={() => {
              onChange(i.id);
              setPos(null);
            }}
            className="flex w-full items-center justify-between gap-3 px-3 py-2 text-start text-sm text-[var(--hob-ink)] hover:bg-[var(--hob-hover)]"
          >
            <span className="truncate">{itemLabel(i)}</span>
            <span
              className={`dm shrink-0 text-xs font-semibold ${
                itemTotal(i) <= 0 ? "text-[#e2445c]" : "text-[var(--hob-good)]"
              }`}
            >
              {itemTotal(i)} במלאי
            </span>
          </button>
        ))}
        {items.length === 0 && (
          <div className="px-3 py-2 text-sm text-[var(--hob-faint)]">אין פריטים — הוסיפו קודם למלאי</div>
        )}
      </Dropdown>
    </div>
  );
}

// Inline "one more item for this person" line — item + size + qty + confirm.
export function AddLineInline({
  items,
  onAdd,
}: {
  items: SeedItem[];
  onAdd: (line: { itemId: number; qty: number; size: string; location: string }) => void;
}) {
  const [itemId, setItemId] = useState(0);
  const [size, setSize] = useState("");
  const [qty, setQty] = useState(1);
  const [location, setLocation] = useState(lastLocation);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="min-w-0 flex-1">
        <ItemPicker items={items} value={itemId} onChange={setItemId} />
      </div>
      <div className="w-20 shrink-0">
        <SizePicker value={size} onChange={setSize} bordered />
      </div>
      <div className="shrink-0 rounded-md border border-[var(--hob-rule-strong)] bg-[var(--hob-surface)]">
        <QtyStepper value={qty} onChange={(v) => setQty(Math.max(1, v))} />
      </div>
      <div className="w-36 shrink-0">
        <LocPicker value={location} onChange={setLocation} />
      </div>
      <button
        type="button"
        disabled={!itemId}
        onClick={() => {
          if (!itemId) return;
          onAdd({ itemId, qty, size: size.trim(), location });
          setItemId(0);
          setQty(1);
          setSize("");
        }}
        className="h-9 shrink-0 rounded-md bg-[var(--hob-accent)] px-3 text-sm font-medium text-white hover:bg-[var(--hob-accent-hover)] disabled:cursor-not-allowed disabled:bg-[var(--hob-faint)]"
      >
        הוסף
      </button>
    </div>
  );
}

// ---- Add-item row ----

export function AddItemRow({
  onAdd,
}: {
  onAdd: (name: string, size: string, qty: number) => void;
}) {
  const [name, setName] = useState("");
  const [size, setSize] = useState("");
  const [qty, setQty] = useState("");
  const submit = () => {
    const n = name.trim();
    const q = Math.max(0, Math.trunc(Number(qty) || 0));
    if (!n) return;
    onAdd(n, size.trim(), q);
    setName("");
    setSize("");
    setQty("");
  };
  const onKey = (e: KeyboardEvent) => e.key === "Enter" && submit();
  return (
    <div
      className="flex flex-wrap items-center gap-2 border-t border-[var(--hob-rule)] bg-[var(--hob-surface)] px-3 py-1.5"
      style={{ borderInlineStart: "5px solid transparent" }}
    >
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={onKey}
        placeholder="＋ פריט חדש (למשל: חולצת KEEP DREAMIN)"
        className="h-8 min-w-0 flex-1 rounded-md border border-transparent px-2 text-sm outline-none placeholder:text-[var(--hob-faint)] focus:border-[var(--hob-accent)]"
      />
      <input
        value={qty}
        onChange={(e) => setQty(e.target.value)}
        onKeyDown={onKey}
        placeholder="כמות"
        inputMode="numeric"
        title="נכנס לעמודת 'בלי מידה' — את הפיצול למידות ממלאים בשורת הפריט"
        className="h-8 w-20 rounded-md border border-[var(--hob-rule)] px-2 text-center text-sm outline-none placeholder:text-[var(--hob-faint)] focus:border-[var(--hob-accent)]"
      />
      {name.trim() && (
        <button
          type="button"
          onClick={submit}
          className="rounded-md bg-[var(--hob-accent)] px-3 py-1 text-sm font-bold text-[var(--hob-accent-fg)] hover:bg-[var(--hob-accent-hover)]"
        >
          הוספה
        </button>
      )}
    </div>
  );
}

// ---- Multi-item line builder (shared by the gift and sale forms) ----
//
// The current picker row is itself the "last line": submitting uses the added
// lines PLUS the picker's current selection, so the common one-item case
// never needs the "עוד פריט" button.

function LineChips({
  items,
  lines,
  withPrice,
  onRemove,
}: {
  items: SeedItem[];
  lines: Line[];
  withPrice: boolean;
  onRemove: (index: number) => void;
}) {
  if (!lines.length) return null;
  const label = (l: Line) => {
    const item = items.find((i) => i.id === l.itemId);
    const base = item ? itemLabel(item) : `פריט #${l.itemId}`;
    return `${base}${l.size ? ` מידה ${l.size}` : ""}${l.qty > 1 ? ` ×${l.qty}` : ""}${withPrice ? ` · ₪${l.price}` : ""}`;
  };
  return (
    <div className="mb-2 flex flex-wrap gap-1.5">
      {lines.map((l, idx) => (
        <span
          key={`${l.itemId}-${idx}`}
          className="flex items-center gap-1.5 rounded-full bg-[var(--hob-hover)] px-2.5 py-1 text-[13px] text-[var(--hob-ink)]"
        >
          {label(l)}
          <button
            type="button"
            onClick={() => onRemove(idx)}
            className="text-[var(--hob-faint)] hover:text-[#e2445c]"
            aria-label="הסרת פריט"
          >
            ✕
          </button>
        </span>
      ))}
    </div>
  );
}

// ---- Add-gift form ----

export function AddGiftForm({
  items,
  onAdd,
}: {
  items: SeedItem[];
  onAdd: (gift: {
    items: { itemId: number; qty: number; size: string }[];
    person: string;
    handle: string;
    kind: string;
    location: string;
    status: string;
    givenAt: string;
  }) => void;
}) {
  const [lines, setLines] = useState<Line[]>([]);
  const [itemId, setItemId] = useState(0);
  const [person, setPerson] = useState("");
  const [handle, setHandle] = useState("");
  const [kind, setKind] = useState("influencer");
  const [qty, setQty] = useState(1);
  const [size, setSize] = useState("");
  const [location, setLocation] = useState(lastLocation);
  const [givenAt, setGivenAt] = useState(todayISO());

  const addLine = () => {
    if (!itemId) return;
    setLines((l) => [...l, { itemId, qty, size: size.trim(), price: 0 }]);
    setItemId(0);
    setQty(1);
    setSize("");
  };
  const allLines = [...lines, ...(itemId ? [{ itemId, qty, size: size.trim(), price: 0 }] : [])];
  const canSubmit = allLines.length > 0 && person.trim().length > 0;
  const submit = () => {
    if (!canSubmit) return;
    onAdd({
      items: allLines.map((l) => ({ itemId: l.itemId, qty: l.qty, size: l.size })),
      person: person.trim(),
      handle: handle.trim(),
      kind,
      location,
      status: "given",
      givenAt,
    });
    setLines([]);
    setPerson("");
    setHandle("");
    setQty(1);
    setSize("");
    setItemId(0);
  };
  return (
    <div className="mb-3 rounded-lg border border-[var(--hob-rule-strong)] bg-[var(--hob-surface)] p-3 shadow-sm">
      <div className="mb-2 text-sm font-semibold text-[var(--hob-ink)]">רישום חלוקה חדשה</div>
      <LineChips
        items={items}
        lines={lines}
        withPrice={false}
        onRemove={(idx) => setLines((l) => l.filter((_, i) => i !== idx))}
      />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-[1.2fr_1fr_1fr_auto_auto_auto_auto_auto]">
        <input
          value={person}
          onChange={(e) => setPerson(e.target.value)}
          placeholder="שם (למי נתת?)"
          className="col-span-2 h-9 rounded-md border border-[var(--hob-rule-strong)] px-2 text-sm outline-none placeholder:text-[var(--hob-faint)] focus:border-[var(--hob-accent)] sm:col-span-1"
        />
        <input
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          placeholder="@אינסטגרם (לא חובה)"
          dir="ltr"
          className="h-9 rounded-md border border-[var(--hob-rule-strong)] px-2 text-sm outline-none placeholder:text-[var(--hob-faint)] focus:border-[var(--hob-accent)]"
        />
        <ItemPicker items={items} value={itemId} onChange={setItemId} />
        <div className="w-24">
          <SizePicker value={size} onChange={setSize} bordered />
        </div>
        <div className="rounded-md border border-[var(--hob-rule-strong)]">
          <QtyStepper value={qty} onChange={(v) => setQty(Math.max(1, v))} />
        </div>
        <button
          type="button"
          onClick={addLine}
          disabled={!itemId}
          title="הוספת הפריט לרשימה כדי לבחור פריט נוסף לאותו אדם"
          className="h-9 rounded-md border border-dashed border-[var(--hob-accent)] px-2.5 text-sm text-[var(--hob-accent)] hover:bg-[var(--hob-hover)] disabled:cursor-not-allowed disabled:border-[var(--hob-rule-strong)] disabled:text-[var(--hob-faint)]"
        >
          ＋ עוד פריט
        </button>
        <div className="rounded-md border border-[var(--hob-rule-strong)]">
          <KindCell value={kind} rounded onChange={setKind} />
        </div>
        <div className="w-40">
          <LocPicker value={location} onChange={setLocation} />
        </div>
      </div>
      <button
        type="button"
        onClick={submit}
        disabled={!canSubmit}
        className="mt-2 h-9 w-full rounded-md bg-[var(--hob-accent)] text-sm font-medium text-white hover:bg-[var(--hob-accent-hover)] disabled:cursor-not-allowed disabled:bg-[var(--hob-faint)] sm:w-auto sm:px-6"
      >
        🎁 רישום חלוקה (המלאי יתעדכן אוטומטית)
      </button>
    </div>
  );
}

// ---- Add-sale form (manual sales until Shopify is live) ----

export function AddSaleForm({
  items,
  onAdd,
}: {
  items: SeedItem[];
  onAdd: (sale: {
    items: { itemId: number; qty: number; size: string; price: number }[];
    buyer: string;
    location: string;
    payMethod: string;
    soldAt: string;
  }) => void;
}) {
  const [lines, setLines] = useState<Line[]>([]);
  const [itemId, setItemId] = useState(0);
  const [buyer, setBuyer] = useState("");
  const [qty, setQty] = useState(1);
  const [size, setSize] = useState("");
  const [location, setLocation] = useState(lastLocation);
  const [payMethod, setPayMethod] = useState(lastPayMethod);
  const [price, setPrice] = useState("");
  const [soldAt, setSoldAt] = useState(todayISO());

  const priceNum = Math.max(0, Number(price) || 0);
  const addLine = () => {
    if (!itemId) return;
    setLines((l) => [...l, { itemId, qty, size: size.trim(), price: priceNum }]);
    setItemId(0);
    setQty(1);
    setSize("");
    setPrice("");
  };
  const allLines = [
    ...lines,
    ...(itemId ? [{ itemId, qty, size: size.trim(), price: priceNum }] : []),
  ];
  const canSubmit = allLines.length > 0 && buyer.trim().length > 0;
  const total = allLines.reduce((s, l) => s + l.price * l.qty, 0);
  const submit = () => {
    if (!canSubmit) return;
    onAdd({ items: allLines, buyer: buyer.trim(), location, payMethod, soldAt });
    setLines([]);
    setBuyer("");
    setQty(1);
    setSize("");
    setPrice("");
    setItemId(0);
  };
  return (
    <div className="mb-3 rounded-lg border border-[var(--hob-rule-strong)] bg-[var(--hob-surface)] p-3 shadow-sm">
      <div className="mb-2 text-sm font-semibold text-[var(--hob-ink)]">רישום מכירה חדשה</div>
      <LineChips
        items={items}
        lines={lines}
        withPrice
        onRemove={(idx) => setLines((l) => l.filter((_, i) => i !== idx))}
      />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-[1.2fr_1fr_auto_auto_auto_auto_auto_auto]">
        <input
          value={buyer}
          onChange={(e) => setBuyer(e.target.value)}
          placeholder="שם הקונה"
          className="col-span-2 h-9 rounded-md border border-[var(--hob-rule-strong)] px-2 text-sm outline-none placeholder:text-[var(--hob-faint)] focus:border-[var(--hob-good)] sm:col-span-1"
        />
        <ItemPicker
          items={items}
          value={itemId}
          onChange={(id) => {
            setItemId(id);
            // Auto-fill the item's fixed price; typing over it still wins.
            const it = items.find((x) => x.id === id);
            if (it && it.price > 0) setPrice(String(it.price));
          }}
        />
        <div className="w-24">
          <SizePicker value={size} onChange={setSize} bordered />
        </div>
        <div className="rounded-md border border-[var(--hob-rule-strong)]">
          <QtyStepper value={qty} onChange={(v) => setQty(Math.max(1, v))} />
        </div>
        <input
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          placeholder="₪ ליחידה"
          inputMode="decimal"
          className="h-9 w-24 rounded-md border border-[var(--hob-rule-strong)] px-2 text-center text-sm outline-none placeholder:text-[var(--hob-faint)] focus:border-[var(--hob-good)]"
        />
        <button
          type="button"
          onClick={addLine}
          disabled={!itemId}
          title="הוספת הפריט לרשימה כדי לבחור פריט נוסף לאותו קונה"
          className="h-9 rounded-md border border-dashed border-[var(--hob-good)] px-2.5 text-sm text-[var(--hob-good)] hover:bg-[#00c875]/15 disabled:cursor-not-allowed disabled:border-[var(--hob-rule-strong)] disabled:text-[var(--hob-faint)]"
        >
          ＋ עוד פריט
        </button>
        <div className="w-40">
          <LocPicker value={location} onChange={setLocation} />
        </div>
        <div className="w-32 overflow-hidden rounded-md" title="איך שילמו">
          <PillCell
            value={payMethod}
            vocab={PAY_METHOD}
            order={PAY_METHOD_ORDER}
            rounded
            onChange={(v) => {
              setPayMethod(v);
              try {
                localStorage.setItem("hob_pay", v);
              } catch {
                // Private-mode storage errors must not break the picker.
              }
            }}
          />
        </div>
      </div>
      <button
        type="button"
        onClick={submit}
        disabled={!canSubmit}
        className="mt-2 h-9 w-full rounded-md bg-[var(--hob-good)] text-sm font-medium text-white hover:bg-[#006e40] disabled:cursor-not-allowed disabled:bg-[var(--hob-faint)] sm:w-auto sm:px-6"
      >
        🛒 רישום מכירה{total > 0 ? <> — {Shs(total)}</> : ""} (המלאי יתעדכן אוטומטית)
      </button>
    </div>
  );
}

// ---- Mini dashboard: top items, kind split, gifts vs sales by week ----
// All computed client-side from the rows already in memory; bars are plain
// divs so no chart library rides along in the bundle.

function BarRow({
  label,
  given,
  sold,
  max,
}: {
  label: string;
  given: number;
  sold: number;
  max: number;
}) {
  const w = (n: number) => `${Math.max(2, Math.round((n / Math.max(1, max)) * 100))}%`;
  return (
    <div className="flex items-center gap-2 text-[12px]">
      <span className="w-24 shrink-0 truncate text-[var(--hob-soft)]" title={label}>
        {label}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {given > 0 && (
          <div className="flex items-center gap-1">
            <div className="h-2.5 rounded-sm" style={{ width: w(given), backgroundColor: GIFT_COLOR }} />
            <span className="dm text-[#a25ddc]">{given}</span>
          </div>
        )}
        {sold > 0 && (
          <div className="flex items-center gap-1">
            <div className="h-2.5 rounded-sm" style={{ width: w(sold), backgroundColor: SALE_COLOR }} />
            <span className="dm text-[var(--hob-good)]">{sold}</span>
          </div>
        )}
      </div>
    </div>
  );
}

export function StatsPanel({ gifts, sales }: { gifts: SeedGift[]; sales: SeedSale[] }) {
  const stats = useMemo(() => {
    // Top items across gifts + sales.
    const byItem = new Map<string, { given: number; sold: number }>();
    for (const g of gifts) {
      const e = byItem.get(g.item_label) ?? { given: 0, sold: 0 };
      e.given += g.qty;
      byItem.set(g.item_label, e);
    }
    for (const s of sales) {
      const e = byItem.get(s.item_label) ?? { given: 0, sold: 0 };
      e.sold += s.qty;
      byItem.set(s.item_label, e);
    }
    const topItems = [...byItem.entries()]
      .map(([label, e]) => ({ label, ...e, total: e.given + e.sold }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 5);
    const itemMax = Math.max(1, ...topItems.flatMap((i) => [i.given, i.sold]));

    // People per kind (each person counted once, by their row's kind).
    const kindOfPerson = new Map<string, string>();
    for (const g of gifts) {
      if (!kindOfPerson.has(g.person.trim())) kindOfPerson.set(g.person.trim(), normalizeKind(g.kind));
    }
    const kindCounts = new Map<string, number>();
    for (const kind of kindOfPerson.values()) {
      kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1);
    }
    const kinds = [...kindCounts.entries()].sort((a, b) => b[1] - a[1]);

    // Gifts vs sales per week (weeks start on Sunday; timestamps are recorded
    // silently even though the UI dropped the date column).
    const weekOf = (iso: string): string => {
      const d = new Date(`${iso}T12:00:00Z`);
      if (Number.isNaN(d.getTime())) return "";
      d.setUTCDate(d.getUTCDate() - d.getUTCDay());
      return d.toISOString().slice(0, 10);
    };
    const byWeek = new Map<string, { given: number; sold: number }>();
    for (const g of gifts) {
      const k = weekOf(g.given_at);
      if (!k) continue;
      const e = byWeek.get(k) ?? { given: 0, sold: 0 };
      e.given += g.qty;
      byWeek.set(k, e);
    }
    for (const s of sales) {
      const k = weekOf(s.sold_at);
      if (!k) continue;
      const e = byWeek.get(k) ?? { given: 0, sold: 0 };
      e.sold += s.qty;
      byWeek.set(k, e);
    }
    const weeks = [...byWeek.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .slice(0, 6)
      .map(([week, e]) => ({ label: `שבוע ${formatHebDate(week)}`, ...e }));
    const weekMax = Math.max(1, ...weeks.flatMap((w) => [w.given, w.sold]));

    return { topItems, itemMax, kinds, weeks, weekMax };
  }, [gifts, sales]);

  const [open, setOpen] = useState(true);
  if (gifts.length === 0 && sales.length === 0) return null;
  return (
    <section className="mb-5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="mb-1.5 flex items-center gap-2 text-base font-semibold text-[var(--hob-ink)]"
      >
        <span className={`inline-block transition-transform ${open ? "" : "-rotate-90"}`} aria-hidden>
          ▾
        </span>
        📊 סטטיסטיקות
        <span className="text-xs font-normal text-[var(--hob-faint)]">
          <span style={{ color: GIFT_COLOR }}>■</span> חולקו{" "}
          <span style={{ color: SALE_COLOR }}>■</span> נמכרו
        </span>
      </button>
      {open && (
        <div className="grid gap-2 sm:grid-cols-3">
          <div className="rounded-lg border border-[var(--hob-rule)] bg-[var(--hob-surface)] p-3 shadow-sm">
            <div className="mb-2 text-[13px] font-semibold text-[var(--hob-ink)]">פריטים מבוקשים</div>
            <div className="space-y-1.5">
              {stats.topItems.map((i) => (
                <BarRow key={i.label} label={i.label} given={i.given} sold={i.sold} max={stats.itemMax} />
              ))}
            </div>
          </div>
          <div className="rounded-lg border border-[var(--hob-rule)] bg-[var(--hob-surface)] p-3 shadow-sm">
            <div className="mb-2 text-[13px] font-semibold text-[var(--hob-ink)]">לפי שבוע</div>
            <div className="space-y-1.5">
              {stats.weeks.map((w) => (
                <BarRow key={w.label} label={w.label} given={w.given} sold={w.sold} max={stats.weekMax} />
              ))}
            </div>
          </div>
          <div className="rounded-lg border border-[var(--hob-rule)] bg-[var(--hob-surface)] p-3 shadow-sm">
            <div className="mb-2 text-[13px] font-semibold text-[var(--hob-ink)]">מי קיבל (אנשים לפי סוג)</div>
            <div className="flex flex-wrap gap-1.5">
              {stats.kinds.map(([kind, count]) => {
                const style = kindStyle(kind);
                return (
                  <span
                    key={kind}
                    className="rounded-full px-2.5 py-1 text-[12px] font-medium text-white"
                    style={{ backgroundColor: style.bg }}
                  >
                    {style.label} · <span className="dm">{count}</span>
                  </span>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

// ---- The seeding view ----

// ---- 🎪 Pop-up mode: full-screen quick-sale for physical events ----
// Three taps per sale (product → size → confirm); every confirm goes through
// the SAME sale_add pipeline as the regular form, so stock, finance, the log
// and the sale alert in Bruno's board thread all just work. No new tables, no new endpoints.
