// 💰 Finance tab: shared expense log, live budget-vs-actual with traffic
// lights, and an interactive profit simulator — the web version of the
// partners' SEGULA-כספים.xlsx workbook.
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isDemo } from "../demo";
import { parseMoney } from "../board";
import type { Figure } from "../../../lib/figure";

export type Expense = {
  id: number;
  date: string;
  payer: string;
  category: string;
  description: string;
  amount: number;
  paid_from?: string;
  /** Read off a photographed receipt — 0 / "" for anything typed by hand. */
  vat?: number;
  tax_id?: string;
};
type Budget = { category: string; amount: number; position: number };
export type Receipt = { id: number; expense_id: number | null; mime: string; created_at: string };
export type Revenue = { gross: number; orders: number; byMethod?: Record<string, number> };

// Payment channels, same labels and colors as the sales log in the seeding tab.
export const PAY_LABEL: Record<string, { label: string; color: string }> = {
  shopify: { label: "🛍 שופיפיי — לבנק", color: "#0073ea" },
  hyp: { label: "💳 Hyp — סולק", color: "#14142b" },
  bit: { label: "📱 ביט", color: "#a25ddc" },
  cash: { label: "💵 מזומן", color: "#00854d" },
  transfer: { label: "🏦 העברה", color: "#fdab3d" },
  "": { label: "לא סומן", color: "#9699a6" },
};
export const PAY_ORDER = ["shopify", "hyp", "bit", "cash", "transfer", ""];

// Where business money physically is. A card sale is NOT bank money yet: it
// sits at the clearer (Shopify / Hyp) for a few days and arrives minus a fee,
// so those two get their own "on its way" pots and only reach `bank` when a
// settlement row records the deposit. Bit, cash and direct transfers are
// already where they say they are.
export const POT_LABEL: Record<string, { label: string; color: string }> = {
  bank: { label: "🏦 בבנק", color: "#0073ea" },
  p_shopify: { label: "⏳ בדרך — שופיפיי", color: "#579bfc" },
  p_hyp: { label: "⏳ בדרך — Hyp", color: "#fdab3d" },
  bit: { label: "📱 ביט", color: "#a25ddc" },
  cash: { label: "💵 מזומן", color: "#00854d" },
  "": { label: "לא סומן", color: "#9699a6" },
};
export const POT_ORDER = ["bank", "p_shopify", "p_hyp", "bit", "cash"];
// A clearer's balance can hold money but can never pay for anything, so only
// these three are offered when tagging an expense.
const EXPENSE_POTS = ["bank", "bit", "cash"];
export const POT_OF_PAY: Record<string, string> = {
  shopify: "p_shopify",
  hyp: "p_hyp",
  transfer: "bank",
  bit: "bit",
  cash: "cash",
};
export const PROVIDERS = ["shopify", "hyp"] as const;
export const PROVIDER_LABEL: Record<string, string> = { shopify: "שופיפיי", hyp: "Hyp" };
export type Scenario = { name: string; data: string; position: number };
export type DailySale = { date: string; units: number; revenue: number };
type DropProfit = {
  collection: string;
  units: number;
  revenue: number;
  cost: number;
  totalCost?: number;
  stockValue: number;
};
type Settlement = { id: number; date: string; provider: string; net: number; gross: number; note: string };
/** דופק המכירות כפי שהשרת מחשב (finance.server getSalesPulse): 7 ימים ישראליים כולל היום. */
export type PulseWindow = { orders: number; units: number; revenue: number; from: string; to: string };
export type SalesPulse = { last7: PulseWindow; prev7: PulseWindow; weeks: (PulseWindow & { weeksAgo: number })[]; from: string; to: string; source: string; asOf: string };
/** תמונת הכסף (finance.summary.server moneySnapshot), רק מה שהמסך מציג. */
export type MoneyFigures = {
  asOf: string;
  balances: { bank: Figure; bit: Figure; cash: Figure };
  receivables: { clearing: Figure; consignment: Figure };
  liabilities: { buyout: Figure; commissions: Figure };
  free: Figure;
};
export type FinanceData = {
  pulse?: SalesPulse | null;
  money?: MoneyFigures | null;
  expenses: Expense[];
  budgets: Budget[];
  totalBudget: number;
  revenue?: Revenue;
  scenarios?: Scenario[];
  dailySales?: DailySale[];
  receipts?: Receipt[];
  dropProfits?: DropProfit[];
  settlements?: Settlement[];
  feeRates?: Record<string, number>;
  bankOpening?: number;
  /** null = לא הוזנה יתרת פתיחה (שונה מאפס: אז השורה היא רק מה שנרשם בלוח). */
  bitOpening?: number | null;
  cashOpening?: number | null;
  /** יום החתימה על הרכישה מדימה ("" = עוד לא נחתם). ממנו הכסף של יוגב. */
  buyoutDate?: string;
  /** יתרות הפתיחה של החשבון החדש ביום החתימה (null = לא הוזן). */
  newOpenings?: { bank: number | null; bit: number | null; cash: number | null };
  /** המכירות מיום החתימה והלאה (null כשאין תאריך). */
  revenueSince?: Revenue | null;
};

// Labels/colors for the profit panel — same identity as the stock screen's
// collection groups (seeding.tsx COLLECTIONS).
export const DROP_META: Record<string, { label: string; color: string }> = {
  drop4: { label: "דרופ 4 · כדורגל", color: "#00854d" },
  drop3: { label: "דרופ 3 · DREAMERS", color: "#0073ea" },
  prev: { label: "דרופים קודמים", color: "#a25ddc" },
  side: { label: "אחר · צד", color: "#676879" },
  "": { label: "לא משויך", color: "#9699a6" },
};
export const DROP_ORDER = ["drop4", "drop3", "prev", "side", ""];

// 27.9: יוגב קנה את החלק של דימה. ההוצאות שדימה שילם עברו אליו אבל נשארות
// קבוצה נפרדת בסגול ("מהרכישה", מיגרציה 0108). אפשר רק לסנן אותן, לא לרשום
// חדשות: הטופס מציע רק את PAYER_NEW.
export const PAYER_LABEL: Record<string, string> = { yogev: "יוגב", yogev_buyout: "יוגב · מהרכישה", business: "העסק" };
export const PAYER_ORDER = ["yogev", "yogev_buyout", "business"];
export const PAYER_NEW = ["yogev", "business"] as const;
// Out of Yogev's own pocket, including what came to him with the buyout.
export const POCKET_PAYERS = ["yogev", "yogev_buyout"] as const;
// One color per payer, used everywhere (KPIs, journal rows, filter tabs) so the eye learns it once.
export const PAYER_COLOR: Record<string, string> = { yogev: "#0073ea", yogev_buyout: "#a25ddc", business: "#323338" };
export const PAYER_BG: Record<string, string> = { yogev: "#e5f1ff", yogev_buyout: "#f3e8ff", business: "#eceff8" };
export const NIS = (n: number) => (isDemo() ? "••• ₪" : `${Math.round(n).toLocaleString("en-US")} ₪`);
// Demo mode (🥷 in the header): amounts stay in place; body.hob-demo CSS
// smears every .dm / .dm-block — same look as the personal dashboard.
export const Sh = (n: number) => <span className="dm">{NIS(n)}</span>;

export async function api(body?: Record<string, unknown>): Promise<FinanceData> {
  const res = await fetch("/api/finance", {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw new Error("unauthorized");
  if (!res.ok) throw new Error(`http ${res.status}`);
  return (await res.json()) as FinanceData;
}

export function todayISO(): string {
  const d = new Date();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

// ---- KPI card ----
// With onClick the card becomes a toggle for a breakdown panel below it —
// the caret is the only hint that there is more to see.
export function Kpi({
  label,
  value,
  accent,
  sub,
  onClick,
  open,
}: {
  label: string;
  value: ReactNode;
  accent?: string;
  sub?: string;
  onClick?: () => void;
  open?: boolean;
}) {
  return (
    <div
      className={`flex-1 min-w-[140px] rounded-xl bg-[var(--hob-surface)] p-4 shadow-sm${
        onClick ? " cursor-pointer transition-shadow hover:shadow-md" : ""
      }`}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
    >
      <div className="flex items-center gap-1 text-xs text-[var(--hob-soft)]">
        <span>{label}</span>
        {onClick && (
          <span className="text-[10px] text-[var(--hob-faint)]" style={{ color: open ? accent : undefined }}>
            {open ? "▲" : "▼"}
          </span>
        )}
      </div>
      <div className="mt-1 text-2xl font-bold" style={{ color: accent ?? "#323338" }}>
        {value}
      </div>
      {sub && <div className={`mt-0.5 text-[11px] text-[var(--hob-faint)]${/\d/.test(sub) ? " dm-block" : ""}`}>{sub}</div>}
    </div>
  );
}

// parseMoney (comma-tolerant number parsing) now lives in board.tsx and is
// shared by every tab — the same "23,312 → 23" bug existed in five places.

// ---- Inline money editor (the per-drop costs) ----
// Same interaction as EditableKpi, sized for a text row. 0 renders as an
// explicit "הזינו עלות" nudge so an untyped cost never masquerades as profit.
export function EditableMoney({ value, onSave }: { value: number; onSave: (n: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value || ""));
  if (editing) {
    return (
      <input
        autoFocus
        dir="ltr"
        inputMode="numeric"
        className="w-20 rounded border border-[var(--hob-accent)] px-1.5 py-0 text-right text-[13px] font-bold"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setEditing(false);
          const n = parseMoney(draft);
          if (isFinite(n) && n >= 0 && n !== value) onSave(n);
        }}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
    );
  }
  return (
    <button
      type="button"
      className={`font-bold underline decoration-dotted underline-offset-2 ${
        value > 0 ? "text-[var(--hob-ink)]" : "text-[var(--hob-accent)]"
      }`}
      onClick={() => {
        setDraft(String(value || ""));
        setEditing(true);
      }}
    >
      {value > 0 ? Sh(value) : "הזינו עלות"}
    </button>
  );
}

// ---- Editable KPI (the overall budget) ----
export function EditableKpi({
  label,
  amount,
  onSave,
  sub,
}: {
  label: string;
  amount: number;
  onSave: (n: number) => void;
  sub?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(amount));
  return (
    <div className="flex-1 min-w-[140px] rounded-xl bg-[var(--hob-surface)] p-4 shadow-sm">
      <div className="text-xs text-[var(--hob-soft)]">{label}</div>
      {editing ? (
        <input
          autoFocus
          dir="ltr"
          inputMode="numeric"
          className="mt-1 w-28 rounded border border-[var(--hob-accent)] px-2 py-0.5 text-right text-xl font-bold"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => {
            setEditing(false);
            const n = parseMoney(value);
            if (isFinite(n) && n > 0 && n !== amount) onSave(n);
          }}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
      ) : (
        <button
          type="button"
          className="mt-1 text-2xl font-bold text-[var(--hob-ink)] underline decoration-dotted underline-offset-4"
          onClick={() => {
            setValue(String(amount));
            setEditing(true);
          }}
        >
          {Sh(amount)}
        </button>
      )}
      {sub && <div className={`mt-0.5 text-[11px] text-[var(--hob-faint)]${/\d/.test(sub) ? " dm-block" : ""}`}>{sub}</div>}
    </div>
  );
}

// ---- Receipts -----------------------------------------------------------
// Phones shoot 3-4MB stills and the partners photograph receipts on cellular
// data, so shrink in the browser first: 1600px longest edge at JPEG 0.8 lands
// around 200-400KB and a receipt stays perfectly readable.
async function shrinkImage(file: File): Promise<{ blob: Blob; mime: string }> {
  if (file.type === "application/pdf") return { blob: file, mime: file.type };
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(bitmap, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", 0.8));
    if (!blob) throw new Error("encode failed");
    return { blob, mime: "image/jpeg" };
  } catch {
    // A format the browser cannot decode (some HEIC) — send it as it came.
    return { blob: file, mime: file.type || "image/jpeg" };
  }
}

export function ReceiptCell({
  expenseId,
  receipts,
  onView,
  onChanged,
  camera,
}: {
  expenseId: number;
  receipts: Receipt[];
  onView: (id: number) => void;
  onChanged: () => void;
  /** The camera only exists while "📷 צילום קבלה" is on — otherwise a row
   *  shows nothing but the clip, and every amount stays on one line. */
  camera?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // More than one receipt on an expense is rare; keep the cell one button wide
  // (alignment) and let repeated clicks walk through them.
  const [idx, setIdx] = useState(0);
  const inputId = `rcpt-${expenseId}`;
  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setFailed(false);
    try {
      const { blob, mime } = await shrinkImage(file);
      const res = await fetch(`/api/receipt?expense_id=${expenseId}`, {
        method: "POST",
        headers: { "content-type": mime },
        body: blob,
      });
      if (!res.ok) throw new Error(`http ${res.status}`);
      onChanged();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  const showCamera = camera || busy || failed;
  return (
    // Fixed width — the same slot on every row, with or without a receipt, so
    // the amounts to its right form a straight column.
    <span className={`flex shrink-0 items-center justify-end gap-1 ${showCamera ? "w-14" : "w-7"}`}>
      {receipts.length > 0 && (
        <button
          type="button"
          onClick={() => {
            onView(receipts[idx % receipts.length].id);
            setIdx((i) => i + 1);
          }}
          title={receipts.length > 1 ? `${receipts.length} קבלות — כל לחיצה מציגה את הבאה` : "הצגת הקבלה"}
          className="rounded px-1 text-[13px] text-[var(--hob-accent)] hover:bg-[#0073ea]/15"
        >
          📎{receipts.length > 1 ? receipts.length : ""}
        </button>
      )}
      {showCamera && (
        <label
          htmlFor={inputId}
          title="צילום קבלה"
          className={`cursor-pointer rounded px-1 text-[13px] ${
            failed ? "text-[#e2445c]" : "text-[var(--hob-faint)] hover:text-[var(--hob-accent)]"
          }`}
        >
          {busy ? "…" : failed ? "↻" : "📷"}
        </label>
      )}
      <input
        id={inputId}
        type="file"
        accept="image/*,application/pdf"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          void upload(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </span>
  );
}

// Full-screen look at one receipt. Deliberately plain: the point is to read
// the paper, and on a phone that means as much screen as possible.
export function ReceiptViewer({
  id,
  expense,
  onClose,
  onDeleted,
}: {
  id: number;
  /** The expense this receipt is filed under, when it has one. */
  expense?: Expense;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/80 p-4"
      onClick={onClose}
    >
      {/* What was read off this paper. It lives here rather than in the journal
          row: the accountant's numbers are worth having, but not at the price
          of a cluttered ledger. */}
      {expense && (
        <div
          className="mb-2 flex w-full max-w-3xl flex-wrap items-baseline gap-x-3 gap-y-1 text-[12px] text-white/80"
          onClick={(e) => e.stopPropagation()}
        >
          <b className="text-sm text-white dm">{Sh(expense.amount)}</b>
          <span>{expense.category}</span>
          {expense.description && <span className="text-white/60">{expense.description}</span>}
          {expense.vat ? <span className="dm">מע"מ {Sh(expense.vat)}</span> : null}
          {expense.tax_id ? <span dir="ltr">ח.פ {expense.tax_id}</span> : null}
        </div>
      )}
      <div className="mb-2 flex w-full max-w-3xl items-center justify-between text-white" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2">
          <a
            href={`/api/receipt?id=${id}`}
            target="_blank"
            rel="noreferrer"
            className="rounded-md bg-white/15 px-3 py-1.5 text-xs hover:bg-white/25"
          >
            פתיחה בכרטיסייה חדשה
          </a>
          <button
            type="button"
            onClick={async () => {
              if (!confirming) {
                setConfirming(true);
                return;
              }
              await fetch(`/api/receipt?delete=${id}`, { method: "POST" });
              onDeleted();
            }}
            className={`rounded-md px-3 py-1.5 text-xs ${confirming ? "bg-[#e2445c]" : "bg-white/15 hover:bg-white/25"}`}
          >
            {confirming ? "בטוח? מחיקה" : "מחיקה"}
          </button>
        </div>
        <button type="button" onClick={onClose} className="rounded-md bg-white/15 px-3 py-1.5 text-xs hover:bg-white/25">
          סגירה ✕
        </button>
      </div>
      <img
        src={`/api/receipt?id=${id}`}
        alt="קבלה"
        className="max-h-[85vh] max-w-full rounded-lg bg-[var(--hob-surface)] object-contain"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}

// ---- Which pot a business expense came out of (journal cell) ----
// Untagged rows show a nudge instead of a label, so the ones still missing a
// pot are the ones that catch the eye.
export function PotCell({ value, onPick }: { value: string; onPick: (pot: string) => void }) {
  const [open, setOpen] = useState(false);
  const tagged = EXPENSE_POTS.includes(value);
  if (open) {
    return (
      <span className="flex shrink-0 items-center gap-1">
        {EXPENSE_POTS.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => {
              onPick(k);
              setOpen(false);
            }}
            className="rounded-full px-2 py-0.5 text-[11px] font-medium text-white"
            style={{ backgroundColor: POT_LABEL[k].color }}
          >
            {POT_LABEL[k].label}
          </button>
        ))}
        <button type="button" onClick={() => setOpen(false)} className="px-1 text-[11px] text-[var(--hob-faint)]">
          ✕
        </button>
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium"
      style={
        tagged
          ? { background: POT_LABEL[value].color, color: "#fff" }
          : { background: "#fff4e0", color: "#b06c00" }
      }
    >
      {/* A phone shows the pill's emoji alone — the width it gives back is
          what the category needs to stay readable. */}
      <span className="sm:hidden">{tagged ? POT_LABEL[value].label.split(" ")[0] : "מאיפה?"}</span>
      <span className="hidden sm:inline">{tagged ? POT_LABEL[value].label : "מאיפה שולם?"}</span>
    </button>
  );
}

// ---- Recording a deposit from a clearer ----
// The partners read one number off the bank statement ("1,430 נכנס מ-Hyp") and
// type it here. Everything else is derived: which sales it closes, what the
// fee was, and what percentage that really is. `gross` is left blank in the
// normal case — a clearer pays out the whole batch it is holding.
export function SettlementBox({
  defaultOpen,
  settlements,
  feeRates,
  busy,
  onAdd,
  onDelete,
  onRate,
}: {
  /** נפתח מוכן לרישום (קישור "רשום הפקדה" מ"היום שלך"). */
  defaultOpen?: boolean;
  settlements: Settlement[];
  feeRates: Record<string, number>;
  busy: boolean;
  onAdd: (body: { date: string; provider: string; net: number; gross: number; note: string; confirm?: boolean }) => Promise<unknown>;
  onDelete: (id: number) => void;
  onRate: (provider: string, percent: number) => void;
}) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  const [provider, setProvider] = useState<string>("hyp");
  const [net, setNet] = useState("");
  const [gross, setGross] = useState("");
  const [date, setDate] = useState(todayISO());
  const [note, setNote] = useState("");

  const savingSettlement = useRef(false);
  // חשד לכפילות מהשרת: הזיכוי לא נרשם עד שמאשרים שהוא חדש.
  const [suspect, setSuspect] = useState<string[] | null>(null);
  const submit = async (confirm = false) => {
    if (busy || savingSettlement.current) return;
    const n = parseMoney(net);
    if (!isFinite(n) || n <= 0) return;
    const g = parseMoney(gross);
    savingSettlement.current = true;
    try {
      const res = (await onAdd({ date, provider, net: n, gross: isFinite(g) && g > 0 ? g : 0, note: note.trim(), confirm })) as { saved?: boolean; suspect?: boolean; reasons?: string[] } | undefined;
      if (res?.suspect && res.saved === false) {
        setSuspect(res.reasons ?? []);
        return;
      }
      setSuspect(null);
      setNet((current) => current === net ? "" : current);
      setGross((current) => current === gross ? "" : current);
      setNote((current) => current === note ? "" : current);
    } catch {
      // The global mutation handler shows the error; preserve the user's input.
    } finally {
      savingSettlement.current = false;
    }
  };

  return (
    <div className="mt-3 rounded-lg bg-[var(--hob-bg2)] p-2.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-baseline justify-between text-right"
      >
        <b className="text-[12px] text-[var(--hob-ink)]">🏦 רישום זיכוי שנכנס לבנק</b>
        <span className="text-[11px] text-[var(--hob-faint)]">
          {settlements.length > 0 ? `${settlements.length} זיכויים` : "עוד לא נרשם אף זיכוי"} {open ? "▲" : "▼"}
        </span>
      </button>

      {open && (
        <>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <div className="flex shrink-0 gap-1">
              {PROVIDERS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setProvider(p)}
                  className="rounded-md px-2.5 py-2 text-[12px] font-medium"
                  style={
                    provider === p
                      ? { background: POT_LABEL[p === "shopify" ? "p_shopify" : "p_hyp"].color, color: "#fff" }
                      : { background: "var(--hob-surface)", color: "var(--hob-soft)" }
                  }
                >
                  {PROVIDER_LABEL[p]}
                </button>
              ))}
            </div>
            <input
              dir="ltr"
              inputMode="decimal"
              value={net}
              onChange={(e) => setNet(e.target.value)}
              placeholder="כמה נכנס ₪"
              className="w-28 rounded-md border border-[var(--hob-rule-strong)] px-2 py-2 text-right text-[15px] font-bold focus:border-[#037f4c] focus:outline-none"
            />
            <input
              dir="ltr"
              inputMode="decimal"
              value={gross}
              onChange={(e) => setGross(e.target.value)}
              placeholder="ברוטו (רשות)"
              className="w-28 rounded-md border border-[var(--hob-rule-strong)] px-2 py-2 text-right text-[13px] focus:border-[#037f4c] focus:outline-none"
            />
            <input
              dir="ltr"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="rounded-md border border-[var(--hob-rule-strong)] px-2 py-2 text-[13px] focus:border-[#037f4c] focus:outline-none"
            />
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="הערה"
              className="min-w-24 flex-1 rounded-md border border-[var(--hob-rule-strong)] px-2 py-2 text-[13px] focus:border-[#037f4c] focus:outline-none"
            />
            <button
              type="button"
              disabled={busy || !net}
              onClick={() => void submit()}
              className="rounded-md bg-[#0073ea] px-3 py-2 text-[13px] font-bold text-white disabled:opacity-40"
            >
              רשום
            </button>
          </div>
          {suspect && (
            <div className="mt-2 rounded-md border border-[#fdab3d] bg-[var(--hob-surface)] p-2 text-[12px] text-[var(--hob-ink)]">
              <b>הזיכוי לא נרשם. יכול להיות שהוא כבר קיים:</b>
              <ul className="mt-1 list-disc pe-4">{suspect.map((r) => <li key={r}>{r}</li>)}</ul>
              <div className="mt-2 flex gap-2">
                <button type="button" disabled={busy} onClick={() => void submit(true)} className="rounded-md bg-[#0073ea] px-3 py-1.5 font-bold text-white disabled:opacity-40">זה זיכוי חדש, לרשום</button>
                <button type="button" onClick={() => setSuspect(null)} className="rounded-md border border-[var(--hob-rule-strong)] px-3 py-1.5 text-[var(--hob-soft)]">ביטול</button>
              </div>
            </div>
          )}
          <div className="mt-1 text-[11px] text-[var(--hob-faint)]">
            "ברוטו" ריק = הזיכוי סוגר את כל מה שפתוח אצל הספק (המקרה הרגיל). מלאו אותו רק כשהזיכוי מכסה חלק מהמכירות.
          </div>

          {/* Estimated rate — only matters until a real deposit replaces it */}
          <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-[var(--hob-hover)] pt-2">
            <span className="text-[11px] text-[var(--hob-faint)]">אחוז עמלה משוער (עד שיהיה זיכוי אמיתי):</span>
            {PROVIDERS.map((p) => (
              <NumField
                key={p}
                label={PROVIDER_LABEL[p]}
                value={(feeRates[p] ?? 0) * 100}
                onSave={(v) => onRate(p, v)}
              />
            ))}
          </div>

          {settlements.length > 0 && (
            <div className="mt-2 grid gap-1 border-t border-[var(--hob-hover)] pt-2">
              {settlements.map((s) => {
                const fee = s.gross - s.net;
                return (
                  <div key={s.id} className="flex flex-wrap items-baseline gap-x-2 text-[12px]">
                    <span dir="ltr" className="shrink-0 text-[var(--hob-faint)]">
                      {s.date}
                    </span>
                    <span className="shrink-0 font-medium text-[var(--hob-ink)]">
                      {PROVIDER_LABEL[s.provider] ?? s.provider}
                    </span>
                    <b className="shrink-0 text-[#00854d] dm-block">{NIS(s.net)}</b>
                    {s.gross > 0 && (
                      <span className="text-[11px] text-[var(--hob-faint)]">
                        מתוך <span className="dm">{NIS(s.gross)}</span> · עמלה{" "}
                        <span className="dm">{NIS(fee)}</span> ({((fee / s.gross) * 100).toFixed(2)}%)
                      </span>
                    )}
                    {s.note && <span className="truncate text-[11px] text-[var(--hob-faint)]">{s.note}</span>}
                    <button
                      type="button"
                      onClick={() => onDelete(s.id)}
                      className="mr-auto shrink-0 px-1 text-[11px] text-[var(--hob-faint)] hover:text-[#e2445c]"
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Small inline number field — click to edit, Enter or blur to save. Used both
// for a fee percentage and for a shekel amount, so the unit and the ceiling
// come from the caller.
export function NumField({
  label,
  value: current,
  unit = "%",
  max = 50,
  width = "w-14",
  onSave,
}: {
  label: string;
  value: number;
  unit?: string;
  max?: number;
  width?: string;
  onSave: (v: number) => void;
}) {
  const [value, setValue] = useState(current.toFixed(2));
  useEffect(() => setValue(current.toFixed(2)), [current]);
  const commit = () => {
    const v = parseMoney(value);
    if (isFinite(v) && v >= 0 && v < max && Math.abs(v - current) > 0.001) onSave(v);
    else setValue(current.toFixed(2));
  };
  return (
    <span className="flex items-center gap-1 text-[11px]">
      {label && <span className="text-[var(--hob-soft)]">{label}</span>}
      <input
        dir="ltr"
        inputMode="decimal"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        className={`${width} rounded border border-[var(--hob-rule-strong)] px-1 py-0.5 text-right focus:border-[#037f4c] focus:outline-none`}
      />
      <span className="text-[var(--hob-faint)]">{unit}</span>
    </span>
  );
}

// ---- Budget bar ----
export function BudgetRow({
  budget,
  spent,
  onSetBudget,
}: {
  budget: Budget;
  spent: number;
  onSetBudget: (category: string, amount: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(budget.amount));
  const pct = budget.amount > 0 ? spent / budget.amount : 0;
  const color = pct >= 0.9 ? "#e2445c" : pct >= 0.7 ? "#fdab3d" : "#00c875";
  return (
    <div className="py-2">
      <div className="mb-1 flex items-center justify-between text-sm">
        <span className="font-medium text-[var(--hob-ink)]">{budget.category}</span>
        <span className="text-[var(--hob-soft)]">
          {Sh(spent)}
          <span className="text-[var(--hob-faint)]"> / </span>
          {editing ? (
            <input
              autoFocus
              dir="ltr"
              className="w-20 rounded border border-[var(--hob-accent)] px-1 text-right text-sm"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onBlur={() => {
                setEditing(false);
                const n = parseMoney(value);
                if (isFinite(n) && n >= 0 && n !== budget.amount) onSetBudget(budget.category, n);
              }}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            />
          ) : (
            <button
              type="button"
              className="underline decoration-dotted underline-offset-2 hover:text-[var(--hob-accent)]"
              onClick={() => {
                setValue(String(budget.amount));
                setEditing(true);
              }}
              title="לחיצה לעריכת התקציב"
            >
              {Sh(budget.amount)}
            </button>
          )}
        </span>
      </div>
      <div className="h-2.5 overflow-hidden rounded-full bg-[var(--hob-hover)]">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${Math.min(100, pct * 100)}%`, background: color }}
        />
      </div>
    </div>
  );
}

// ---- Drop simulator: define ANY drop's products, play with prices, save scenarios ----
