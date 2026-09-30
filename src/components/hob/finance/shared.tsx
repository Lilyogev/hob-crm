// כספים: types, labels and the small widgets the finance tab is built from.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { isDemo } from "../demo";
import { parseMoney } from "../board";
import { PARTNER, PAYERS, PAYER_LABEL as PARTNER_PAYER_LABEL, type Payer } from "../../../lib/partners";

export type Expense = {
  id: number;
  date: string;
  /** avia | lior | business */
  payer: string;
  category: string;
  description: string;
  amount: number;
  paid_from?: string;
  /** Read off a photographed receipt; 0 / "" for anything typed by hand. */
  vat?: number;
  tax_id?: string;
};
export type Income = { id: number; date: string; amount: number; source: string; handled_by: string; note: string };
export type Budget = { category: string; amount: number; position: number };
export type Receipt = { id: number; expense_id: number | null; mime: string; created_at: string };
export type Revenue = {
  gross: number;
  orders: number;
  sales: number;
  manual: number;
  byMethod: Record<string, number>;
  bySource: Record<string, number>;
  byHandler: { sales: Record<string, number>; manual: Record<string, number> };
};
export type PocketBalance = { avia: number; lior: number; ahead: "avia" | "lior" | null; transfer: number; text: string };

/** נתון בתמונת הכסף (finance.summary.server): ערך או null, מקור, תאריך ומצב אמינות. */
export type FigureState = "verified" | "recorded" | "estimate" | "planned" | "pending";
export type Figure = { value: number | null; source: string; asOf: string | null; note?: string; state?: FigureState };
export const FIGURE_STATE_HE: Record<FigureState, string> = {
  verified: "מאומת",
  recorded: "נרשם בלוח, לא מאומת מול הבנק",
  estimate: "אומדן",
  planned: "מתוכנן",
  pending: "ממתין לאישור",
};
export function figureMeta(f: Figure): string {
  return [f.state ? FIGURE_STATE_HE[f.state] : "", `מקור: ${f.source}`, f.asOf ? `עודכן ${f.asOf.slice(0, 10)}` : "לא ידוע מתי עודכן"].filter(Boolean).join(" · ");
}

// Payment channels of the sales ledger, same labels as the stock tab.
export const PAY_LABEL: Record<string, { label: string; color: string }> = {
  shopify: { label: "🛍 שופיפיי", color: "#0073ea" },
  bit: { label: "📱 ביט", color: "#a25ddc" },
  cash: { label: "💵 מזומן", color: "#00854d" },
  transfer: { label: "🏦 העברה", color: "#fdab3d" },
  "": { label: "לא סומן", color: "#9699a6" },
};
export const PAY_ORDER = ["shopify", "bit", "cash", "transfer", ""];

// Manual income sources.
export const INCOME_SOURCES = ["", "shopify", "popup", "wholesale", "other"] as const;
export const SOURCE_LABEL: Record<string, { label: string; color: string }> = {
  shopify: { label: "🛍 שופיפיי", color: "#0073ea" },
  popup: { label: "🎪 פופ-אפ", color: "#a25ddc" },
  wholesale: { label: "🏬 סיטונאי", color: "#7f5347" },
  other: { label: "✨ אחר", color: "#676879" },
  "": { label: "לא סומן", color: "#9699a6" },
};

// Who handled a sale / an income: a partner, or nobody tagged yet.
export const HANDLERS = ["avia", "lior", ""] as const;
export const HANDLER_LABEL: Record<string, { label: string; color: string }> = {
  avia: { label: PARTNER.avia.label, color: PARTNER.avia.color },
  lior: { label: PARTNER.lior.label, color: PARTNER.lior.color },
  "": { label: "לא סומן", color: "#9699a6" },
};

// Where business money physically is. A store sale is NOT bank money yet: it
// sits at the clearer for a few days and arrives minus a fee, so it gets an
// "on its way" pot and only reaches `bank` when a settlement records the
// deposit. Bit, cash and direct transfers are already where they say they are.
export const POT_LABEL: Record<string, { label: string; color: string }> = {
  bank: { label: "🏦 בבנק", color: "#0073ea" },
  p_shopify: { label: "⏳ בדרך משופיפיי", color: "#579bfc" },
  bit: { label: "📱 ביט", color: "#a25ddc" },
  cash: { label: "💵 מזומן", color: "#00854d" },
  "": { label: "לא סומן", color: "#9699a6" },
};
export const POT_ORDER = ["bank", "p_shopify", "bit", "cash"];
// A clearer's balance can hold money but can never pay for anything, so only
// these three are offered when tagging an expense.
export const EXPENSE_POTS = ["bank", "bit", "cash"];
export const POT_OF_PAY: Record<string, string> = { shopify: "p_shopify", transfer: "bank", bit: "bit", cash: "cash" };
export const PROVIDERS = ["shopify"] as const;
export const PROVIDER_LABEL: Record<string, string> = { shopify: "שופיפיי" };
export type Scenario = { name: string; data: string; position: number };
export type DailySale = { date: string; units: number; revenue: number };
export type DropProfit = { collection: string; units: number; revenue: number; cost: number; stockValue: number };
export type Settlement = { id: number; date: string; provider: string; net: number; gross: number; note: string };
/** דופק המכירות כפי שהשרת מחשב (finance.server getSalesPulse). */
export type PulseWindow = { orders: number; units: number; revenue: number; from: string; to: string };
export type SalesPulse = { last7: PulseWindow; prev7: PulseWindow; weeks: (PulseWindow & { weeksAgo: number })[]; from: string; to: string; source: string; asOf: string };
/** תמונת הכסף (finance.summary.server moneySnapshot), רק מה שהמסך מציג. */
export type MoneyFigures = {
  asOf: string;
  balances: { bank: Figure; bit: Figure; cash: Figure };
  receivables: { clearing: Figure };
  liabilities: { commissions: Figure };
  free: Figure;
  gaps: { key: string; text: string; question?: string }[];
};
export type FinanceData = {
  pulse?: SalesPulse | null;
  money?: MoneyFigures | null;
  expenses: Expense[];
  income?: Income[];
  budgets: Budget[];
  /** 0 = לא הוגדר. */
  totalBudget: number;
  revenue?: Revenue;
  pocket?: PocketBalance;
  scenarios?: Scenario[];
  dailySales?: DailySale[];
  receipts?: Receipt[];
  dropProfits?: DropProfit[];
  settlements?: Settlement[];
  feeRates?: Record<string, number>;
  /** null = לא הוזנה יתרת פתיחה (שונה מאפס: אז השורה היא רק מה שנרשם בלוח). */
  openings?: { bank: number | null; bit: number | null; cash: number | null };
  vatExempt?: boolean;
};

// Payer = who paid: a partner from her own pocket, or the business.
export const PAYER_ORDER: readonly Payer[] = PAYERS;
export const PAYER_LABEL: Record<string, string> = PARTNER_PAYER_LABEL;
export const POCKET_PAYERS = ["avia", "lior"] as const;
// One color per payer everywhere (KPIs, journal rows, filters) so the eye learns it once.
export const PAYER_COLOR: Record<string, string> = { avia: PARTNER.avia.color, lior: PARTNER.lior.color, business: "#323338" };
export const PAYER_BG: Record<string, string> = { avia: "#f3e8ff", lior: "#e5f1ff", business: "#eceff8" };
export const NIS = (n: number) => (isDemo() ? "••• ₪" : `${Math.round(n).toLocaleString("en-US")} ₪`);
// Demo mode (🥷 in the header): amounts stay in place; body.hob-demo CSS
// smears every .dm / .dm-block.
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

/** A chip row (payer / pot / source pickers) with one selected key. */
export function Chips({ keys, value, label, color, onPick }: { keys: readonly string[]; value: string; label: (k: string) => string; color: (k: string) => string; onPick: (k: string) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {keys.map((k) => (
        <button
          key={k || "none"}
          type="button"
          onClick={() => onPick(k)}
          className="rounded-full px-3 py-1.5 text-xs transition-colors"
          style={value === k ? { background: color(k), color: "#fff" } : { background: "var(--hob-hover)", color: "var(--hob-soft)" }}
        >
          {label(k)}
        </button>
      ))}
    </div>
  );
}

// ---- KPI card ----
// With onClick the card becomes a toggle for a breakdown panel below it.
export function Kpi({ label, value, accent, sub, onClick, open }: { label: string; value: ReactNode; accent?: string; sub?: string; onClick?: () => void; open?: boolean }) {
  return (
    <div
      className={`flex-1 min-w-[140px] rounded-xl bg-[var(--hob-surface)] p-4 shadow-sm${onClick ? " cursor-pointer transition-shadow hover:shadow-md" : ""}`}
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
      <div className="mt-1 text-2xl font-bold" style={{ color: accent ?? "var(--hob-ink)" }}>
        {value}
      </div>
      {sub && <div className={`mt-0.5 text-[11px] text-[var(--hob-faint)]${/\d/.test(sub) ? " dm-block" : ""}`}>{sub}</div>}
    </div>
  );
}

// ---- Inline money editor (the per-collection production cost) ----
// 0 renders as an explicit nudge so an untyped cost never masquerades as profit.
export function EditableMoney({ value, onSave, empty = "הזינו עלות" }: { value: number; onSave: (n: number) => void; empty?: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value || ""));
  if (editing) {
    return (
      <input
        autoFocus
        dir="ltr"
        inputMode="numeric"
        className="w-20 rounded border border-[var(--hob-accent)] bg-transparent px-1.5 py-0 text-right text-[13px] font-bold"
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
      className={`font-bold underline decoration-dotted underline-offset-2 ${value > 0 ? "text-[var(--hob-ink)]" : "text-[var(--hob-accent)]"}`}
      onClick={() => {
        setDraft(String(value || ""));
        setEditing(true);
      }}
    >
      {value > 0 ? Sh(value) : empty}
    </button>
  );
}

// ---- Editable KPI (the overall budget). amount 0 = not set. ----
export function EditableKpi({ label, amount, onSave, sub, empty = "הגדירו תקציב" }: { label: string; amount: number; onSave: (n: number) => void; sub?: string; empty?: string }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(amount || ""));
  return (
    <div className="flex-1 min-w-[140px] rounded-xl bg-[var(--hob-surface)] p-4 shadow-sm">
      <div className="text-xs text-[var(--hob-soft)]">{label}</div>
      {editing ? (
        <input
          autoFocus
          dir="ltr"
          inputMode="numeric"
          className="mt-1 w-28 rounded border border-[var(--hob-accent)] bg-transparent px-2 py-0.5 text-right text-xl font-bold"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => {
            setEditing(false);
            const n = parseMoney(value);
            if (isFinite(n) && n >= 0 && n !== amount) onSave(n);
          }}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
      ) : (
        <button
          type="button"
          className={`mt-1 font-bold underline decoration-dotted underline-offset-4 ${amount > 0 ? "text-2xl text-[var(--hob-ink)]" : "text-base text-[var(--hob-accent)]"}`}
          onClick={() => {
            setValue(String(amount || ""));
            setEditing(true);
          }}
        >
          {amount > 0 ? Sh(amount) : empty}
        </button>
      )}
      {sub && <div className={`mt-0.5 text-[11px] text-[var(--hob-faint)]${/\d/.test(sub) ? " dm-block" : ""}`}>{sub}</div>}
    </div>
  );
}

// ---- Receipts -----------------------------------------------------------
// Phones shoot 3-4MB stills and receipts are photographed on cellular data,
// so shrink in the browser first: 1600px longest edge at JPEG 0.8 lands
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
    // A format the browser cannot decode (some HEIC): send it as it came.
    return { blob: file, mime: file.type || "image/jpeg" };
  }
}

export function ReceiptCell({ expenseId, receipts, onView, onChanged, camera }: { expenseId: number; receipts: Receipt[]; onView: (id: number) => void; onChanged: () => void; camera?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // More than one receipt on an expense is rare; keep the cell one button wide
  // and let repeated clicks walk through them.
  const [idx, setIdx] = useState(0);
  const inputId = `rcpt-${expenseId}`;
  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setFailed(false);
    try {
      const { blob, mime } = await shrinkImage(file);
      const res = await fetch(`/api/receipt?expense_id=${expenseId}`, { method: "POST", headers: { "content-type": mime }, body: blob });
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
    <span className={`flex shrink-0 items-center justify-end gap-1 ${showCamera ? "w-14" : "w-7"}`}>
      {receipts.length > 0 && (
        <button
          type="button"
          onClick={() => {
            onView(receipts[idx % receipts.length].id);
            setIdx((i) => i + 1);
          }}
          title={receipts.length > 1 ? `${receipts.length} קבלות — כל לחיצה מציגה את הבאה` : "הצגת הקבלה"}
          className="rounded px-1 text-[13px] text-[var(--hob-accent)] hover:bg-[var(--hob-hover)]"
        >
          📎{receipts.length > 1 ? receipts.length : ""}
        </button>
      )}
      {showCamera && (
        <label htmlFor={inputId} title="צילום קבלה" className={`cursor-pointer rounded px-1 text-[13px] ${failed ? "text-[#e2445c]" : "text-[var(--hob-faint)] hover:text-[var(--hob-accent)]"}`}>
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
export function ReceiptViewer({ id, expense, onClose, onDeleted }: { id: number; expense?: Expense; onClose: () => void; onDeleted: () => void }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/80 p-4" onClick={onClose}>
      {expense && (
        <div className="mb-2 flex w-full max-w-3xl flex-wrap items-baseline gap-x-3 gap-y-1 text-[12px] text-white/80" onClick={(e) => e.stopPropagation()}>
          <b className="text-sm text-white dm">{Sh(expense.amount)}</b>
          <span>{expense.category}</span>
          {expense.description && <span className="text-white/60">{expense.description}</span>}
          {expense.vat ? <span className="dm">מע"מ {Sh(expense.vat)}</span> : null}
          {expense.tax_id ? <span dir="ltr">ח.פ {expense.tax_id}</span> : null}
        </div>
      )}
      <div className="mb-2 flex w-full max-w-3xl items-center justify-between text-white" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2">
          <a href={`/api/receipt?id=${id}`} target="_blank" rel="noreferrer" className="rounded-md bg-white/15 px-3 py-1.5 text-xs hover:bg-white/25">
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
      <img src={`/api/receipt?id=${id}`} alt="קבלה" className="max-h-[85vh] max-w-full rounded-lg bg-[var(--hob-surface)] object-contain" onClick={(e) => e.stopPropagation()} />
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
      style={tagged ? { background: POT_LABEL[value].color, color: "#fff" } : { background: "#fff4e0", color: "#b06c00" }}
    >
      <span className="sm:hidden">{tagged ? POT_LABEL[value].label.split(" ")[0] : "מאיפה?"}</span>
      <span className="hidden sm:inline">{tagged ? POT_LABEL[value].label : "מאיפה שולם?"}</span>
    </button>
  );
}

// ---- Recording a deposit from the clearer ----
// One number off the bank statement ("נכנס משופיפיי 1,430") is typed here.
// Everything else is derived: which sales it closes, what the fee was, and
// what percentage that really is. `gross` is left blank in the normal case.
export function SettlementBox({ defaultOpen, settlements, feeRates, busy, onAdd, onDelete, onRate }: {
  /** נפתח מוכן לרישום (קישור "רשמו הפקדה" מ"היום שלך"). */
  defaultOpen?: boolean;
  settlements: Settlement[];
  feeRates: Record<string, number>;
  busy: boolean;
  onAdd: (body: { date: string; provider: string; net: number; gross: number; note: string; confirm?: boolean }) => Promise<unknown>;
  onDelete: (id: number) => void;
  onRate: (provider: string, percent: number) => void;
}) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  const provider = PROVIDERS[0];
  const [net, setNet] = useState("");
  const [gross, setGross] = useState("");
  const [date, setDate] = useState(todayISO());
  const [note, setNote] = useState("");

  const savingSettlement = useRef(false);
  // חשד לכפילות מהשרת: הזיכוי לא נרשם עד שמאשרות שהוא חדש.
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
      setNet((current) => (current === net ? "" : current));
      setGross((current) => (current === gross ? "" : current));
      setNote((current) => (current === note ? "" : current));
    } catch {
      // The global mutation handler shows the error; preserve the input.
    } finally {
      savingSettlement.current = false;
    }
  };

  return (
    <div className="mt-3 rounded-lg bg-[var(--hob-bg2)] p-2.5">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-baseline justify-between text-right">
        <b className="text-[12px] text-[var(--hob-ink)]">🏦 רישום זיכוי משופיפיי שנכנס לבנק</b>
        <span className="text-[11px] text-[var(--hob-faint)]">
          {settlements.length > 0 ? `${settlements.length} זיכויים` : "עוד לא נרשם אף זיכוי"} {open ? "▲" : "▼"}
        </span>
      </button>

      {open && (
        <>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <input dir="ltr" inputMode="decimal" value={net} onChange={(e) => setNet(e.target.value)} placeholder="כמה נכנס ₪" className="w-28 rounded-md border border-[var(--hob-rule-strong)] bg-transparent px-2 py-2 text-right text-[15px] font-bold focus:border-[var(--hob-accent)] focus:outline-none" />
            <input dir="ltr" inputMode="decimal" value={gross} onChange={(e) => setGross(e.target.value)} placeholder="ברוטו (רשות)" className="w-28 rounded-md border border-[var(--hob-rule-strong)] bg-transparent px-2 py-2 text-right text-[13px] focus:border-[var(--hob-accent)] focus:outline-none" />
            <input dir="ltr" type="date" value={date} onChange={(e) => setDate(e.target.value)} className="rounded-md border border-[var(--hob-rule-strong)] bg-transparent px-2 py-2 text-[13px] focus:border-[var(--hob-accent)] focus:outline-none" />
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="הערה" className="min-w-24 flex-1 rounded-md border border-[var(--hob-rule-strong)] bg-transparent px-2 py-2 text-[13px] focus:border-[var(--hob-accent)] focus:outline-none" />
            <button type="button" disabled={busy || !net} onClick={() => void submit()} className="rounded-md bg-[#0073ea] px-3 py-2 text-[13px] font-bold text-white disabled:opacity-40">
              רשמו
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
            "ברוטו" ריק = הזיכוי סוגר את כל מה שפתוח אצל הסולק (המקרה הרגיל). מלאו אותו רק כשהזיכוי מכסה חלק מהמכירות.
          </div>

          {/* Estimated rate, only matters until a real deposit replaces it */}
          <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-[var(--hob-hover)] pt-2">
            <span className="text-[11px] text-[var(--hob-faint)]">אחוז עמלה משוער (עד שיהיה זיכוי אמיתי):</span>
            {PROVIDERS.map((p) => (
              <NumField key={p} label={PROVIDER_LABEL[p]} value={(feeRates[p] ?? 0) * 100} onSave={(v) => onRate(p, v)} />
            ))}
          </div>

          {settlements.length > 0 && (
            <div className="mt-2 grid gap-1 border-t border-[var(--hob-hover)] pt-2">
              {settlements.map((s) => {
                const fee = s.gross - s.net;
                return (
                  <div key={s.id} className="flex flex-wrap items-baseline gap-x-2 text-[12px]">
                    <span dir="ltr" className="shrink-0 text-[var(--hob-faint)]">{s.date}</span>
                    <span className="shrink-0 font-medium text-[var(--hob-ink)]">{PROVIDER_LABEL[s.provider] ?? s.provider}</span>
                    <b className="shrink-0 text-[#00854d] dm-block">{NIS(s.net)}</b>
                    {s.gross > 0 && (
                      <span className="text-[11px] text-[var(--hob-faint)]">
                        מתוך <span className="dm">{NIS(s.gross)}</span> · עמלה <span className="dm">{NIS(fee)}</span> ({((fee / s.gross) * 100).toFixed(2)}%)
                      </span>
                    )}
                    {s.note && <span className="truncate text-[11px] text-[var(--hob-faint)]">{s.note}</span>}
                    <button type="button" onClick={() => onDelete(s.id)} className="mr-auto shrink-0 px-1 text-[11px] text-[var(--hob-faint)] hover:text-[#e2445c]">
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

// Small inline number field: click to edit, Enter or blur to save. Used both
// for a fee percentage and for a shekel amount, so the unit and ceiling
// come from the caller.
export function NumField({ label, value: current, unit = "%", max = 50, width = "w-14", onSave }: { label: string; value: number; unit?: string; max?: number; width?: string; onSave: (v: number) => void }) {
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
      <input dir="ltr" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} className={`${width} rounded border border-[var(--hob-rule-strong)] bg-transparent px-1 py-0.5 text-right focus:border-[var(--hob-accent)] focus:outline-none`} />
      <span className="text-[var(--hob-faint)]">{unit}</span>
    </span>
  );
}

// ---- Budget bar ----
// amount 0 = no budget: no traffic light, just the spend and a nudge to set one.
export function BudgetRow({ budget, spent, onSetBudget, onDelete }: { budget: Budget; spent: number; onSetBudget: (category: string, amount: number) => void; onDelete: (category: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(budget.amount || ""));
  const [confirmDel, setConfirmDel] = useState(false);
  const hasBudget = budget.amount > 0;
  const pct = hasBudget ? spent / budget.amount : 0;
  const color = pct >= 0.9 ? "#e2445c" : pct >= 0.7 ? "#fdab3d" : "#00c875";
  return (
    <div className="py-2">
      <div className="mb-1 flex items-center justify-between gap-2 text-sm">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-medium text-[var(--hob-ink)]">{budget.category}</span>
          {spent === 0 && (
            <button
              type="button"
              onClick={() => {
                if (confirmDel) onDelete(budget.category);
                else setConfirmDel(true);
              }}
              className={`shrink-0 rounded px-1 text-[11px] ${confirmDel ? "bg-[#e2445c] text-white" : "text-[var(--hob-faint)] hover:text-[#e2445c]"}`}
              title="הסרת הקטגוריה"
            >
              {confirmDel ? "בטוח?" : "✕"}
            </button>
          )}
        </span>
        <span className="shrink-0 text-[var(--hob-soft)]">
          {Sh(spent)}
          <span className="text-[var(--hob-faint)]"> / </span>
          {editing ? (
            <input
              autoFocus
              dir="ltr"
              className="w-20 rounded border border-[var(--hob-accent)] bg-transparent px-1 text-right text-sm"
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
              className={`underline decoration-dotted underline-offset-2 hover:text-[var(--hob-accent)] ${hasBudget ? "" : "text-[var(--hob-accent)]"}`}
              onClick={() => {
                setValue(String(budget.amount || ""));
                setEditing(true);
              }}
              title="לחיצה לעריכת התקציב"
            >
              {hasBudget ? Sh(budget.amount) : "הגדירו תקציב"}
            </button>
          )}
        </span>
      </div>
      <div className="h-2.5 overflow-hidden rounded-full bg-[var(--hob-hover)]">
        {hasBudget && <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(100, pct * 100)}%`, background: color }} />}
      </div>
    </div>
  );
}
