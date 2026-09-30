// 💰 כספים: what came in (store + manual income), what went out (expenses,
// by payer and by category), what each partner put in from her own pocket,
// where the business money sits, profit per collection, budgets and the
// drop simulator.
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { parseMoney } from "../board";
import { PARTNER, isPartner } from "../../../lib/partners";

import { PaceStrip, TrafficCard } from "./PaceStrip";
import { Simulator } from "./Simulator";
import {
  BudgetRow, Chips, EditableKpi, EditableMoney, type Expense, type Figure, type FinanceData, HANDLERS, HANDLER_LABEL, INCOME_SOURCES, Kpi, NIS, NumField,
  PAYER_BG, PAYER_COLOR, PAYER_LABEL, PAYER_ORDER, PAY_LABEL, PAY_ORDER, POCKET_PAYERS, POT_LABEL, POT_OF_PAY, POT_ORDER, PROVIDERS, PROVIDER_LABEL,
  PotCell, type Receipt, ReceiptCell, ReceiptViewer, SOURCE_LABEL, SettlementBox, Sh, api, figureMeta, todayISO,
} from "./shared";

const MONTH_HE = ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני", "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"];
const monthLabel = (key: string) => `${MONTH_HE[parseInt(key.slice(5), 10) - 1] ?? key} ${key.slice(0, 4)}`;
const shortDate = (d: string) => d.slice(8) + "/" + d.slice(5, 7);
const inputCls = "rounded-md border border-[var(--hob-rule-strong)] bg-transparent px-3 py-2 text-sm focus:border-[var(--hob-accent)] focus:outline-none";

export function FinanceView({ actor, onAuthLost }: { actor: string; onAuthLost: () => void }) {
  const qc = useQueryClient();
  const query = useQuery<FinanceData, Error>({
    queryKey: ["finance"],
    queryFn: () => api(),
    refetchInterval: 30_000,
    // No backoff dance on an expired session: straight to the login screen.
    retry: (count, error) => error.message !== "unauthorized" && count < 2,
  });
  useEffect(() => {
    if (query.error?.message === "unauthorized") onAuthLost();
  }, [query.error, onAuthLost]);

  const mutate = useMutation({
    mutationFn: (body: Record<string, unknown>) => api(body),
    onSettled: () => qc.invalidateQueries({ queryKey: ["finance"] }),
  });

  const me = isPartner(actor) ? actor : "";
  const [form, setForm] = useState(() => ({
    amount: "",
    category: "",
    description: "",
    date: todayISO(),
    payer: me || "business",
    // Which pot a business expense came out of: the last choice sticks.
    paidFrom: (typeof localStorage !== "undefined" && localStorage.getItem("hob_pot")) || "bank",
  }));
  const [incomeForm, setIncomeForm] = useState(() => ({ amount: "", date: todayISO(), source: "", handledBy: me, note: "" }));
  const [newCategory, setNewCategory] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [confirmDeleteIncome, setConfirmDeleteIncome] = useState<number | null>(null);
  const [payerFilter, setPayerFilter] = useState<string>("all");
  const [catFilter, setCatFilter] = useState<string>("all");
  // Which breakdown is open under the in/out cards: one at a time.
  const [openBreakdown, setOpenBreakdown] = useState<"in" | "out" | null>(null);
  // ?log=settlement (הקישור "רשמו הפקדה" מ"היום שלך") פותח את הקופות ישר על רישום הזיכוי.
  const [logSettlement] = useState(() => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("log") === "settlement");
  const [openPots, setOpenPots] = useState(logSettlement);
  const [showIncome, setShowIncome] = useState(false);
  const settlementRef = useRef<HTMLDivElement>(null);
  const scrolledToSettlement = useRef(false);
  useEffect(() => {
    if (!logSettlement || scrolledToSettlement.current || !settlementRef.current) return;
    scrolledToSettlement.current = true;
    settlementRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    const url = new URL(window.location.href);
    url.searchParams.delete("log");
    window.history.replaceState(null, "", url);
  });
  const [viewReceipt, setViewReceipt] = useState<number | null>(null);
  // A receipt picked from the pending strip, waiting for an expense to land on.
  const [attaching, setAttaching] = useState<number | null>(null);
  // A phone has no hover, so this toggle brings the camera out per row.
  const [cameraMode, setCameraMode] = useState(false);

  const data = query.data;
  const expenses = useMemo(() => data?.expenses ?? [], [data]);
  const income = useMemo(() => data?.income ?? [], [data]);
  const spentByCat = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of expenses) m.set(e.category, (m.get(e.category) ?? 0) + e.amount);
    return m;
  }, [expenses]);
  const totalSpent = expenses.reduce((s, e) => s + e.amount, 0);
  const spentByPayer = useMemo(() => {
    const m: Record<string, number> = { avia: 0, lior: 0, business: 0 };
    for (const e of expenses) m[e.payer] = (m[e.payer] ?? 0) + e.amount;
    return m;
  }, [expenses]);
  const receiptsByExpense = useMemo(() => {
    const m = new Map<number, Receipt[]>();
    for (const r of data?.receipts ?? []) {
      if (r.expense_id == null) continue;
      const list = m.get(r.expense_id);
      if (list) list.push(r);
      else m.set(r.expense_id, [r]);
    }
    return m;
  }, [data]);
  // Receipts nobody has hung on an expense yet (usually a photo sent to Hobi
  // before, or instead of, the amount).
  const pending = (data?.receipts ?? []).filter((r) => r.expense_id == null);
  const totalBudget = data?.totalBudget ?? 0;
  // Two separate pots. The budget is what the partners put in from their own
  // pockets; an expense the business paid out of sales money never touched it.
  const pocketSpent = POCKET_PAYERS.reduce((s, p) => s + (spentByPayer[p] ?? 0), 0);
  const businessSpent = totalSpent - pocketSpent;
  const utilization = totalBudget > 0 ? pocketSpent / totalBudget : 0;

  const savingExpense = useRef(false);
  const submit = () => {
    if (savingExpense.current || mutate.isPending) return;
    const amount = parseMoney(form.amount);
    if (!(amount > 0) || !form.category) return;
    if (form.payer === "business" && typeof localStorage !== "undefined") localStorage.setItem("hob_pot", form.paidFrom);
    savingExpense.current = true;
    const submitted = { ...form };
    mutate.mutate(
      { op: "add_expense", date: form.date, payer: form.payer, category: form.category, description: form.description, amount, paidFrom: form.payer === "business" ? form.paidFrom : "", actor },
      {
        onSuccess: () =>
          setForm((f) => (Object.keys(submitted).every((key) => f[key as keyof typeof f] === submitted[key as keyof typeof submitted]) ? { ...f, amount: "", description: "" } : f)),
        onSettled: () => {
          savingExpense.current = false;
        },
      },
    );
  };
  const savingIncome = useRef(false);
  const submitIncome = () => {
    if (savingIncome.current || mutate.isPending) return;
    const amount = parseMoney(incomeForm.amount);
    if (!(amount > 0)) return;
    savingIncome.current = true;
    mutate.mutate(
      { op: "add_income", date: incomeForm.date, amount, source: incomeForm.source, handledBy: incomeForm.handledBy, note: incomeForm.note, actor },
      {
        onSuccess: () => setIncomeForm((f) => ({ ...f, amount: "", note: "" })),
        onSettled: () => {
          savingIncome.current = false;
        },
      },
    );
  };

  if (query.isLoading) return <div className="py-24 text-center text-[var(--hob-faint)]">טוענת את הכספים…</div>;
  if (query.isError && !query.data) return <div className="py-24 text-center text-[#e2445c]">שגיאה בטעינה — נסו לרענן.</div>;

  const revenue = data?.revenue;
  const grossRevenue = revenue?.gross ?? 0;
  const salesRevenue = revenue?.sales ?? 0;
  const manualRevenue = revenue?.manual ?? 0;
  const salesCount = revenue?.orders ?? 0;
  const byMethod = revenue?.byMethod ?? {};
  const bySource = revenue?.bySource ?? {};
  const payRows = PAY_ORDER.map((key) => ({ key, amount: byMethod[key] ?? 0 })).filter((r) => r.amount > 0);
  const sourceRows = INCOME_SOURCES.map((key) => ({ key, amount: bySource[key] ?? 0 })).filter((r) => r.amount > 0);
  const untagged = byMethod[""] ?? 0;
  // מי טיפלה: מכירות והכנסות ידניות ביחד, לפי שותפה.
  const handlerRows = HANDLERS.map((h) => ({ key: h, sales: revenue?.byHandler.sales[h] ?? 0, manual: revenue?.byHandler.manual[h] ?? 0 }))
    .map((r) => ({ ...r, total: r.sales + r.manual }))
    .filter((r) => r.total > 0);
  const vatExempt = data?.vatExempt !== false;
  // עוסק פטור: no VAT is charged or remitted, every shekel of revenue is theirs.
  // עוסק מורשה: 18% of the price goes to the state.
  const netRevenue = vatExempt ? grossRevenue : grossRevenue / 1.18;
  const realProfit = netRevenue - totalSpent;
  const settlements = data?.settlements ?? [];
  const feeRates = data?.feeRates ?? { shopify: 0.024 };
  // Per provider: how much gross a deposit has already closed, and how much
  // net it actually put in the bank. The difference is the clearer's cut.
  // Not useMemo on purpose: this sits below the early returns (hook count).
  const clearing = (() => {
    const m: Record<string, { gross: number; net: number; fee: number; rate: number }> = {};
    for (const p of PROVIDERS) m[p] = { gross: 0, net: 0, fee: 0, rate: 0 };
    for (const s of settlements) {
      const row = m[s.provider];
      if (!row) continue;
      row.gross += s.gross;
      row.net += s.net;
    }
    for (const p of PROVIDERS) {
      m[p].fee = m[p].gross - m[p].net;
      m[p].rate = m[p].gross > 0 ? m[p].fee / m[p].gross : 0;
    }
    return m;
  })();
  const feesPaid = PROVIDERS.reduce((s, p) => s + clearing[p].fee, 0);
  const settledNet = PROVIDERS.reduce((s, p) => s + clearing[p].net, 0);
  const openings = data?.openings ?? { bank: null, bit: null, cash: null };
  // What is left in each pot. A store sale enters the "on its way" pot and
  // only moves to the bank when a settlement records the deposit, so the bank
  // row is a number that can be checked against the bank statement. Manual
  // income has no pot: it counts in the totals only.
  const potRows = (() => {
    const inn: Record<string, number> = { bank: 0, p_shopify: 0, bit: 0, cash: 0, "": 0 };
    for (const [method, amount] of Object.entries(byMethod)) inn[POT_OF_PAY[method] ?? ""] += amount;
    for (const p of PROVIDERS) inn.p_shopify -= clearing[p].gross;
    inn.bank += settledNet + (openings.bank ?? 0);
    inn.bit += openings.bit ?? 0;
    inn.cash += openings.cash ?? 0;
    const out: Record<string, number> = { bank: 0, p_shopify: 0, bit: 0, cash: 0, "": 0 };
    for (const e of expenses) {
      if (e.payer !== "business") continue;
      const pot = ["bank", "bit", "cash"].includes(e.paid_from ?? "") ? (e.paid_from as string) : "";
      out[pot] += e.amount;
    }
    const keys = [...POT_ORDER, ""].filter((k) => (k === "p_shopify" || k === "" ? Math.abs(inn[k]) > 0.5 || out[k] > 0 : true));
    return keys.map((key) => ({ key, inn: inn[key] ?? 0, out: out[key] ?? 0, left: (inn[key] ?? 0) - (out[key] ?? 0) }));
  })();
  const businessCash = potRows.reduce((s, r) => s + r.left, 0);
  // "כמה כסף יש": מתמונת הכסף של השרת (moneySnapshot), לא מחישוב בדפדפן.
  const money = data?.money ?? null;
  const bankFig = money?.balances.bank ?? null;
  const bankVerified = bankFig !== null && bankFig.value !== null && bankFig.state === "verified" && !bankFig.note;
  const balanceParts = money ? [money.balances.bank, money.balances.bit, money.balances.cash] : [];
  const balancesKnown = money !== null && balanceParts.every((f) => f.value !== null);
  const availableCash = balancesKnown ? balanceParts.reduce((s, f) => s + (f.value ?? 0), 0) : null;
  const pendingCash = money?.receivables.clearing.value ?? null;
  const bankAsOfHe = bankFig?.asOf ? `${Number(bankFig.asOf.slice(8, 10))}.${Number(bankFig.asOf.slice(5, 7))}` : "אף פעם";
  const cashLabel = money === null || bankVerified ? "זמין בבנק, ביט ומזומן" : `יתרה לפי הרישומים, לא אומתה מול הבנק מ-${bankAsOfHe}`;
  const figureRows: { label: string; f: Figure }[] = money
    ? [
        { label: "בנק", f: money.balances.bank },
        { label: "ביט", f: money.balances.bit },
        { label: "מזומן", f: money.balances.cash },
        { label: "מחכה אצל הסולק", f: money.receivables.clearing },
        { label: "כסף פנוי", f: money.free },
      ]
    : [];
  const untaggedOut = potRows.find((r) => r.key === "")?.out ?? 0;
  // Still-in-transit gross, plus what it should net at the current rate.
  const inTransit = PROVIDERS.map((p) => {
    const gross = (byMethod[p] ?? 0) - clearing[p].gross;
    const rate = clearing[p].rate > 0 ? clearing[p].rate : (feeRates[p] ?? 0);
    return { provider: p, gross, rate, net: gross * (1 - rate), actual: clearing[p].rate > 0 };
  }).filter((r) => Math.abs(r.gross) > 0.5);
  const pocket = data?.pocket ?? { avia: 0, lior: 0, ahead: null, transfer: 0, text: "" };
  const budgets = data?.budgets ?? [];
  const categories = budgets.map((b) => b.category);
  const dropProfits = (data?.dropProfits ?? []).filter((d) => d.units > 0 || d.cost > 0 || d.stockValue > 0 || d.collection !== "");

  return (
    <div className="mx-auto max-w-3xl">
      {/* In vs out: the real cash picture */}
      <div className="mb-3 rounded-xl bg-[var(--hob-surface)] p-4 shadow-sm">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-base font-bold text-[var(--hob-ink)]">⚖️ נכנס מול יצא</h3>
          <button
            type="button"
            onClick={() => mutate.mutate({ op: "set_vat_exempt", exempt: !vatExempt })}
            className="rounded-full px-2.5 py-0.5 text-[11px] font-medium"
            style={vatExempt ? { background: "#e6f6ee", color: "#00854d" } : { background: "#fdab3d", color: "#fff" }}
            title="לחיצה מחליפה בין עוסק פטור לעוסק מורשה"
          >
            {vatExempt ? '🧾 עוסק פטור — בלי מע"מ' : '🧾 עוסק מורשה — מע"מ 18%'}
          </button>
        </div>
        <div className="flex flex-wrap gap-3">
          <Kpi
            label="נכנס — הכנסות"
            value={Sh(grossRevenue)}
            accent="#00854d"
            sub={`${salesCount} מכירות בלוח${manualRevenue > 0 ? ` + ${NIS(manualRevenue)} שנרשמו ידנית` : ""}`}
            onClick={grossRevenue > 0 ? () => setOpenBreakdown((p) => (p === "in" ? null : "in")) : undefined}
            open={openBreakdown === "in"}
          />
          <Kpi
            label="יצא — הוצאות"
            value={Sh(totalSpent)}
            accent="#e2445c"
            sub={pocketSpent > 0 && businessSpent > 0 ? "מהכיס + מקופת העסק" : businessSpent > 0 ? "הכל מקופת העסק" : pocketSpent > 0 ? "הכל מהכיס" : "עוד לא נרשמו הוצאות"}
            onClick={totalSpent > 0 ? () => setOpenBreakdown((p) => (p === "out" ? null : "out")) : undefined}
            open={openBreakdown === "out"}
          />
          <Kpi
            label={vatExempt ? "הכנסות פחות הוצאות" : 'הכנסות נטו ממע"מ פחות הוצאות'}
            value={Sh(realProfit)}
            accent={realProfit >= 0 ? "#00854d" : "#e2445c"}
            sub="לפני עמלות סליקה · לא יתרת מזומן"
          />
        </div>
        {openBreakdown === "in" && (
          <div className="mt-3 rounded-lg bg-[var(--hob-bg2)] p-2.5">
            <div className="mb-1.5 flex items-baseline justify-between">
              <b className="text-[13px] text-[var(--hob-ink)]">💰 מאיפה נכנס הכסף</b>
              <span className="text-[11px] text-[var(--hob-faint)] dm-block">{untagged > 0 ? `${NIS(untagged)} מכירות עדיין בלי סימון תשלום` : ""}</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {payRows.map((r) => (
                <span key={`m-${r.key || "none"}`} className="rounded-full px-2.5 py-1 text-[12px] font-medium text-white" style={{ backgroundColor: PAY_LABEL[r.key].color }}>
                  {PAY_LABEL[r.key].label} · {Sh(r.amount)}
                </span>
              ))}
              {sourceRows.map((r) => (
                <span key={`s-${r.key || "none"}`} className="rounded-full border px-2.5 py-1 text-[12px] font-medium" style={{ borderColor: SOURCE_LABEL[r.key].color, color: SOURCE_LABEL[r.key].color }}>
                  ידני · {SOURCE_LABEL[r.key].label} · {Sh(r.amount)}
                </span>
              ))}
            </div>
            {handlerRows.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-[var(--hob-hover)] pt-2 text-[11.5px]">
                <span className="text-[var(--hob-soft)]">מי טיפלה:</span>
                {handlerRows.map((r) => (
                  <span key={r.key || "none"} className="rounded-full px-2 py-0.5 font-medium text-white dm-block" style={{ backgroundColor: HANDLER_LABEL[r.key].color }} title={`מכירות ${NIS(r.sales)} · ידני ${NIS(r.manual)}`}>
                    {HANDLER_LABEL[r.key].label} · {NIS(r.total)}
                  </span>
                ))}
              </div>
            )}
            {salesRevenue > 0 && untagged > 0 && <div className="mt-1.5 text-[11px] text-[var(--hob-faint)]">מכירות בלי סימון תשלום או בלי "מי טיפלה" מתייגים בטאב המלאי.</div>}
          </div>
        )}
        {openBreakdown === "out" && (
          <div className="mt-3 rounded-lg bg-[var(--hob-bg2)] p-2.5">
            <div className="mb-1.5 flex items-baseline justify-between">
              <b className="text-[13px] text-[var(--hob-ink)]">🧾 מי הוציאה</b>
              <span className="text-[11px] text-[var(--hob-faint)] dm-block">{businessSpent > 0 ? `מהכיס ${NIS(pocketSpent)} · מקופת העסק ${NIS(businessSpent)}` : `מהכיס ${NIS(pocketSpent)}`}</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {PAYER_ORDER.filter((p) => (spentByPayer[p] ?? 0) > 0).map((p) => (
                <span key={p} className="rounded-full px-2.5 py-1 text-[12px] font-medium text-white" style={{ backgroundColor: PAYER_COLOR[p] }}>
                  {PAYER_LABEL[p]} · {Sh(spentByPayer[p] ?? 0)}
                </span>
              ))}
            </div>
            <div className="mt-1.5 text-[11px] text-[var(--hob-faint)]">התקציב נמדד רק על מה שיצא מהכיס של השותפות. הוצאות העסק משולמות מהמכירות. פירוט מלא ביומן ההוצאות למטה.</div>
          </div>
        )}
      </div>

      {/* From the pocket: what each partner put in, and what evens it out */}
      <div className="mb-3 rounded-xl bg-[var(--hob-surface)] p-4 shadow-sm">
        <div className="mb-2 flex items-baseline justify-between">
          <h3 className="text-base font-bold text-[var(--hob-ink)]">👛 השקעה מהכיס</h3>
          <span className="text-[11px] text-[var(--hob-faint)]">הוצאות ששותפה שילמה בעצמה, לא מקופת העסק</span>
        </div>
        <div className="flex flex-wrap gap-3">
          {POCKET_PAYERS.map((p) => (
            <Kpi key={p} label={`${PARTNER[p].label} שמה מהכיס`} value={Sh(pocket[p])} accent={PARTNER[p].color} />
          ))}
        </div>
        <div className="mt-2 rounded-lg bg-[var(--hob-bg2)] px-2.5 py-2 text-[12px] text-[var(--hob-ink)] dm-block">
          {pocket.ahead === null ? "⚖️ מאוזן: שתיהן שמו אותו סכום מהכיס" : `⚖️ ${pocket.text}`}
          <span className="block text-[11px] text-[var(--hob-faint)]">ההפרש חלקי 2, כדי ששתיהן יהיו באותו סכום. לא כולל מה שהעסק שילם.</span>
        </div>
      </div>

      <PaceStrip pulse={data?.pulse} totalSpent={totalSpent} grossRevenue={grossRevenue} />
      <TrafficCard />

      {/* Profit per collection: revenue from the ledger, production cost typed once per collection. */}
      {dropProfits.length > 0 && (
        <div className="mb-3 rounded-xl bg-[var(--hob-surface)] p-4 shadow-sm">
          <div className="mb-2 flex items-baseline justify-between">
            <h3 className="text-base font-bold text-[var(--hob-ink)]">📈 רווח לפי קולקציה</h3>
            <span className="text-[11px] text-[var(--hob-faint)]">הכנסות אמיתיות מול עלות הייצור שאתן מזינות</span>
          </div>
          <div className="space-y-2">
            {dropProfits.map((d) => {
              const profit = d.revenue - d.cost;
              const covered = d.cost > 0 ? Math.min(100, Math.round((d.revenue / d.cost) * 100)) : null;
              return (
                <div key={d.collection || "none"} className="rounded-lg border border-[var(--hob-rule)] p-3" style={{ borderInlineStart: "4px solid var(--hob-accent)" }}>
                  <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-sm font-bold text-[var(--hob-ink)]">{d.collection || "לא משויך לקולקציה"}</span>
                    <span className={`dm text-sm font-bold ${profit >= 0 ? "text-[var(--hob-good)]" : "text-[#e2445c]"}`}>
                      {d.cost > 0 ? (profit >= 0 ? `רווח ${NIS(profit)}` : `${NIS(profit)} עד איזון`) : ""}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-[var(--hob-soft)]">
                    <span className="dm-block">
                      נמכר: <b className="text-[var(--hob-ink)]">{d.units}</b> יח' · <b className="text-[var(--hob-ink)]">{NIS(d.revenue)}</b>
                    </span>
                    {d.stockValue > 0 && (
                      <span className="dm-block">
                        על המדף עוד <b className="text-[var(--hob-ink)]">{NIS(d.stockValue)}</b>
                      </span>
                    )}
                    <span className="flex items-center gap-1 dm-block">
                      עלות ייצור:
                      <EditableMoney value={d.cost} onSave={(v) => mutate.mutate({ op: "set_drop_cost", collection: d.collection, amount: v })} />
                    </span>
                  </div>
                  {covered !== null && (
                    <div className="mt-2">
                      <div className="h-1.5 overflow-hidden rounded-full bg-[var(--hob-hover)]">
                        <div className="h-full rounded-full" style={{ width: `${covered}%`, backgroundColor: covered >= 100 ? "#00854d" : "var(--hob-accent)" }} />
                      </div>
                      <div className="mt-0.5 text-[11px] text-[var(--hob-faint)] dm-block">{covered >= 100 ? "ההכנסות כיסו את עלות הייצור · לפני עלויות נוספות" : `הוחזרו ${covered}% מעלות הייצור`}</div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* KPIs */}
      <div className="mb-4 flex flex-wrap gap-3">
        <EditableKpi label="תקציב מהכיס (לחיצה לעריכה)" amount={totalBudget} onSave={(amount) => mutate.mutate({ op: "set_total_budget", amount })} sub="כמה שתיכן מוכנות להשקיע מהכיס" />
        {totalBudget > 0 ? (
          <>
            <Kpi label="נותר להשקיע" value={Sh(totalBudget - pocketSpent)} accent="#00854d" sub="מהכיס, בלי הוצאות העסק" />
            <Kpi label="ניצול תקציב" value={<span className="dm">{Math.round(utilization * 100)}%</span>} sub={`${NIS(pocketSpent)} מתוך ${NIS(totalBudget)}`} accent={utilization >= 0.9 ? "#e2445c" : utilization >= 0.7 ? "#fdab3d" : "#00854d"} />
          </>
        ) : (
          <Kpi label="יצא מהכיס עד היום" value={Sh(pocketSpent)} accent="#fdab3d" sub="הגדירו תקציב כדי לראות ניצול" />
        )}
        <Kpi
          label={cashLabel}
          value={availableCash === null ? <span className="text-[15px]">{money === null ? "לא נבדק" : "לא ידוע"}</span> : Sh(availableCash)}
          accent={money === null || availableCash === null ? "#fdab3d" : bankVerified ? (availableCash >= 0 ? "#00854d" : "#e2445c") : "#fdab3d"}
          sub={
            money === null
              ? "תמונת הכסף לא נטענה. זה לא אומר אפס"
              : `${pendingCash === null ? "בדרך משופיפיי: לא ידוע" : `בדרך משופיפיי: ${NIS(pendingCash)} ברוטו`}${money.free.value !== null ? ` · כסף פנוי: ${NIS(money.free.value)}` : " · כסף פנוי: לא מחושב"}`
          }
          onClick={() => setOpenPots((p) => !p)}
          open={openPots}
        />
      </div>

      {/* מקור · עודכן לכל מספר חשוב, בגלוי: מה זה, מאיפה, מתי, ומה מצב האמינות. */}
      {figureRows.length > 0 && (
        <div className="mb-4 grid gap-1 rounded-xl bg-[var(--hob-surface)] px-4 py-2.5 text-[11.5px] text-[var(--hob-faint)] shadow-sm">
          {figureRows.map(({ label, f }) => (
            <div key={label} className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-[var(--hob-soft)]">{label}:</span>
              {f.value === null ? <b style={{ color: "#fdab3d" }}>לא ידוע</b> : <b className="dm text-[var(--hob-ink)]">{NIS(f.value)}</b>}
              <span>{figureMeta(f)}</span>
              {f.note && <span className="basis-full sm:basis-auto">{f.note}</span>}
            </div>
          ))}
        </div>
      )}

      {openPots && (
        <div className="mb-4 rounded-xl bg-[var(--hob-surface)] p-4 shadow-sm">
          <div className="mb-2 flex items-baseline justify-between">
            <b className="text-[13px] text-[var(--hob-ink)]">💰 כמה כסף יש עכשיו</b>
            <span className="text-[11px] text-[var(--hob-faint)]">יתרה = נכנס פחות מה ששולם מאותה קופה</span>
          </div>
          <div className="grid gap-1.5">
            {potRows.map((r) => (
              <div key={r.key || "none"} className="flex items-center gap-2 rounded-lg bg-[var(--hob-bg2)] px-2.5 py-2">
                <span className="shrink-0 rounded-full px-2.5 py-1 text-[12px] font-medium text-white" style={{ backgroundColor: POT_LABEL[r.key].color }}>
                  {POT_LABEL[r.key].label}
                </span>
                <span className="min-w-0 truncate text-[11px] text-[var(--hob-faint)] dm-block">
                  נכנס {NIS(r.inn)} · יצא {NIS(r.out)}
                </span>
                <b className="mr-auto shrink-0 text-[17px]" style={{ color: r.left > 0 ? "#00854d" : r.left < 0 ? "#e2445c" : "#676879" }}>
                  {Sh(r.left)}
                </b>
              </div>
            ))}
          </div>
          <div className="mt-2 flex justify-between border-t border-[var(--hob-hover)] pt-2 text-[12px] text-[var(--hob-soft)]">
            <span>סה"כ כולל כסף בדרך</span>
            <b style={{ color: businessCash >= 0 ? "#00854d" : "#e2445c" }}>{Sh(businessCash)}</b>
          </div>
          <div className="mt-1.5 text-[11px] text-[var(--hob-faint)]">
            שורת הבנק = רק זיכויים שבאמת נחתו בחשבון, בנטו, ואפשר להשוות אותה מול דף הבנק · הוצאות מהכיס והכנסות שנרשמו ידנית לא נוגעות בקופות האלה
            {untaggedOut > 0 && (
              <>
                {" · "}
                <b className="text-[#fdab3d] dm-block">{NIS(untaggedOut)} בלי סימון מאיפה שולם</b> — אפשר לתייג בלחיצה ביומן ההוצאות למטה
              </>
            )}
          </div>

          {inTransit.length > 0 && (
            <div className="mt-3 rounded-lg bg-[var(--hob-bg2)] p-2.5">
              <b className="text-[12px] text-[var(--hob-ink)]">⏳ כסף שעוד לא הגיע לבנק</b>
              <div className="mt-1.5 grid gap-1">
                {inTransit.map((r) => (
                  <div key={r.provider} className="flex flex-wrap items-baseline gap-x-2 text-[12px]">
                    <span className="font-medium text-[var(--hob-ink)]">{PROVIDER_LABEL[r.provider]}</span>
                    <span className="text-[var(--hob-faint)]">
                      ברוטו <span className="dm">{NIS(r.gross)}</span> · עמלה {(r.rate * 100).toFixed(2)}%{r.actual ? " (לפי הזיכויים שלכן)" : " (הערכה)"}
                    </span>
                    <b className="mr-auto text-[13px] text-[var(--hob-ink)]">≈ {Sh(r.net)}</b>
                  </div>
                ))}
              </div>
              <div className="mt-1.5 text-[11px] text-[var(--hob-faint)]">זה הסכום שאמור להיכנס לבנק. כשהוא נכנס, רשמו אותו למטה והלוח יחשב את העמלה האמיתית לבד.</div>
            </div>
          )}

          <div ref={settlementRef}>
            <SettlementBox
              defaultOpen={logSettlement}
              settlements={settlements}
              feeRates={feeRates}
              busy={mutate.isPending}
              onAdd={(body) => mutate.mutateAsync({ op: "add_settlement", actor, ...body })}
              onDelete={(id) => mutate.mutate({ op: "delete_settlement", id })}
              onRate={(provider, percent) => mutate.mutate({ op: "set_fee_rate", provider, percent })}
            />
          </div>

          {feesPaid > 0 && (
            <div className="mt-2 flex justify-between rounded-lg bg-[var(--hob-bg2)] px-2.5 py-2 text-[12px]">
              <span className="text-[var(--hob-soft)]">סה"כ עמלות סליקה ששולמו עד היום</span>
              <b className="text-[#e2445c] dm-block">{NIS(feesPaid)}</b>
            </div>
          )}

          {/* Opening balances: without them a pot is only what the board logged. */}
          {([
            ["bank", "יתרת פתיחה בבנק", openings.bank],
            ["bit", "יתרת פתיחה בביט", openings.bit],
            ["cash", "יתרת פתיחה במזומן", openings.cash],
          ] as const).map(([pot, label, value]) => (
            <div key={pot} className="mt-1.5 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-[var(--hob-bg2)] px-2.5 py-2 text-[12px]">
              <span className="text-[var(--hob-soft)]">
                {label}
                <span className="mr-1 text-[11px] text-[var(--hob-faint)]">{value === null ? "לא הוזנה: השורה מציגה רק מה שנרשם בלוח" : "כסף שהיה לפני שהלוח התחיל לעקוב"}</span>
              </span>
              <NumField label="" value={value ?? 0} unit="₪" max={10000000} width="w-24" onSave={(v) => mutate.mutate({ op: "set_pot_opening", pot, amount: v })} />
            </div>
          ))}
        </div>
      )}

      {/* Add expense */}
      <div className="mb-4 rounded-xl bg-[var(--hob-surface)] p-4 shadow-sm">
        <h3 className="mb-2 text-base font-bold text-[var(--hob-ink)]">➕ רישום הוצאה</h3>
        <div className="flex flex-wrap gap-2">
          <input dir="ltr" inputMode="decimal" placeholder="סכום ₪" className={`w-28 ${inputCls} text-right text-lg font-bold`} value={form.amount} onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} onKeyDown={(e) => e.key === "Enter" && submit()} />
          <select className={`${inputCls} bg-[var(--hob-surface)] px-2`} value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}>
            <option value="">קטגוריה…</option>
            {categories.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <input type="date" className={`${inputCls} px-2`} value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} />
          <Chips keys={PAYER_ORDER} value={form.payer} label={(k) => PAYER_LABEL[k]} color={(k) => PAYER_COLOR[k]} onPick={(payer) => setForm((f) => ({ ...f, payer }))} />
        </div>
        {categories.length === 0 && <div className="mt-1.5 text-[11px] text-[#b06c00]">עוד אין קטגוריות. הוסיפו אחת בפאנל "תקציב מול ביצוע" למטה.</div>}
        {form.payer === "business" && (
          <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-[var(--hob-bg2)] p-2.5">
            <span className="text-xs text-[var(--hob-soft)]">מאיפה שולם?</span>
            <Chips keys={["bank", "bit", "cash"]} value={form.paidFrom} label={(k) => POT_LABEL[k].label} color={(k) => POT_LABEL[k].color} onPick={(paidFrom) => setForm((f) => ({ ...f, paidFrom }))} />
            <span className="text-[11px] text-[var(--hob-faint)]">יורד מהיתרה של אותה קופה</span>
          </div>
        )}
        <div className="mt-2 flex gap-2">
          <input placeholder="על מה? (לא חובה)" className={`flex-1 ${inputCls}`} value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} onKeyDown={(e) => e.key === "Enter" && submit()} />
          <button type="button" onClick={submit} disabled={mutate.isPending || !form.category} className="rounded-md bg-[var(--hob-accent)] px-5 py-2 text-sm font-medium text-[var(--hob-accent-fg)] hover:bg-[var(--hob-accent-hover)] disabled:opacity-50">
            רישום
          </button>
        </div>
      </div>

      {/* Manual income: what the sales ledger does not carry */}
      <div className="mb-4 rounded-xl bg-[var(--hob-surface)] p-4 shadow-sm">
        <button type="button" onClick={() => setShowIncome((v) => !v)} className="flex w-full items-baseline justify-between text-right">
          <h3 className="text-base font-bold text-[var(--hob-ink)]">💵 רישום הכנסה ידנית ({income.length})</h3>
          <span className="text-[11px] text-[var(--hob-faint)]">
            סיטונאי, יום פופ-אפ, מה שלא בספר המכירות {showIncome ? "▲" : "▼"}
          </span>
        </button>
        {showIncome && (
          <>
            <div className="mt-2 flex flex-wrap gap-2">
              <input dir="ltr" inputMode="decimal" placeholder="סכום ₪" className={`w-28 ${inputCls} text-right text-lg font-bold`} value={incomeForm.amount} onChange={(e) => setIncomeForm((f) => ({ ...f, amount: e.target.value }))} onKeyDown={(e) => e.key === "Enter" && submitIncome()} />
              <input type="date" className={`${inputCls} px-2`} value={incomeForm.date} onChange={(e) => setIncomeForm((f) => ({ ...f, date: e.target.value }))} />
              <Chips keys={INCOME_SOURCES.filter((k) => k !== "")} value={incomeForm.source} label={(k) => SOURCE_LABEL[k].label} color={(k) => SOURCE_LABEL[k].color} onPick={(source) => setIncomeForm((f) => ({ ...f, source: f.source === source ? "" : source }))} />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="text-xs text-[var(--hob-soft)]">מי טיפלה?</span>
              <Chips keys={["avia", "lior"]} value={incomeForm.handledBy} label={(k) => HANDLER_LABEL[k].label} color={(k) => HANDLER_LABEL[k].color} onPick={(h) => setIncomeForm((f) => ({ ...f, handledBy: f.handledBy === h ? "" : h }))} />
              <input placeholder="הערה (לא חובה)" className={`min-w-40 flex-1 ${inputCls}`} value={incomeForm.note} onChange={(e) => setIncomeForm((f) => ({ ...f, note: e.target.value }))} onKeyDown={(e) => e.key === "Enter" && submitIncome()} />
              <button type="button" onClick={submitIncome} disabled={mutate.isPending} className="rounded-md bg-[#00854d] px-5 py-2 text-sm font-medium text-white hover:bg-[#026b40] disabled:opacity-50">
                רישום
              </button>
            </div>
            {income.length > 0 && (
              <div className="mt-3 grid gap-1 border-t border-[var(--hob-hover)] pt-2">
                {income.map((i) => (
                  <div key={i.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12.5px]">
                    <span dir="ltr" className="w-11 shrink-0 text-[11px] text-[var(--hob-faint)]">{shortDate(i.date)}</span>
                    <span className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium text-white" style={{ backgroundColor: SOURCE_LABEL[i.source]?.color ?? "#9699a6" }}>
                      {SOURCE_LABEL[i.source]?.label ?? i.source}
                    </span>
                    {i.handled_by && (
                      <span className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium text-white" style={{ backgroundColor: HANDLER_LABEL[i.handled_by]?.color }}>
                        {HANDLER_LABEL[i.handled_by]?.label}
                      </span>
                    )}
                    <span className="min-w-0 flex-1 truncate text-[var(--hob-soft)]">{i.note}</span>
                    <b className="shrink-0 text-[#00854d]">{Sh(i.amount)}</b>
                    <button
                      type="button"
                      onClick={() => {
                        if (confirmDeleteIncome === i.id) {
                          mutate.mutate({ op: "delete_income", id: i.id });
                          setConfirmDeleteIncome(null);
                        } else setConfirmDeleteIncome(i.id);
                      }}
                      className={`shrink-0 rounded px-1.5 text-xs ${confirmDeleteIncome === i.id ? "bg-[#e2445c] text-white" : "text-[var(--hob-faint)] hover:text-[#e2445c]"}`}
                    >
                      {confirmDeleteIncome === i.id ? "בטוח?" : "✕"}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* Expense log */}
      <div className="mb-4 rounded-xl bg-[var(--hob-surface)] p-4 shadow-sm">
        <h3 className="mb-1 text-base font-bold text-[var(--hob-ink)]">🧾 יומן הוצאות (<span className="dm">{expenses.length}</span>)</h3>
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <p className="text-xs text-[var(--hob-faint)]">📎 קבלה מצורפת — לחיצה מציגה אותה · הדרך הנוחה לצרף היא לשלוח להובי תמונה עם הסכום</p>
          <button type="button" onClick={() => setCameraMode((c) => !c)} className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${cameraMode ? "bg-[var(--hob-accent)] text-[var(--hob-accent-fg)]" : "bg-[var(--hob-hover)] text-[var(--hob-soft)]"}`}>
            {cameraMode ? "סיום צילום קבלות" : "📷 צילום קבלה"}
          </button>
        </div>
        {pending.length > 0 && (
          <div className="mb-3 rounded-lg bg-[#fdab3d]/15 p-2.5">
            <div className="mb-1.5 flex items-baseline justify-between">
              <b className="text-[12px] text-[#b06c00]">📎 {pending.length === 1 ? "קבלה שממתינה לשיוך" : `${pending.length} קבלות שממתינות לשיוך`}</b>
              <span className="text-[11px] text-[#b06c00]">{attaching ? 'עכשיו בחרו הוצאה למטה — כפתור "צרפו כאן"' : "לחיצה על קבלה ואז על ההוצאה שלה"}</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {pending.map((r) => (
                <span key={r.id} className="flex items-center gap-1.5 rounded-lg bg-[var(--hob-surface)] p-1.5">
                  <button type="button" onClick={() => setViewReceipt(r.id)} title="הגדלה">
                    <img src={`/api/receipt?id=${r.id}`} alt="קבלה ממתינה" className="h-12 w-12 rounded object-cover" />
                  </button>
                  <button type="button" onClick={() => setAttaching(attaching === r.id ? null : r.id)} className={`rounded-md px-2 py-1 text-[11px] font-medium ${attaching === r.id ? "bg-[var(--hob-accent)] text-[var(--hob-accent-fg)]" : "bg-[var(--hob-hover)] text-[var(--hob-soft)]"}`}>
                    {attaching === r.id ? "בחרו הוצאה…" : "שיוך"}
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}
        <div className="mb-3 flex flex-wrap gap-1.5">
          <button type="button" onClick={() => setPayerFilter("all")} className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${payerFilter === "all" ? "bg-[var(--hob-ink)] text-[var(--hob-bg)]" : "bg-[var(--hob-hover)] text-[var(--hob-soft)]"}`}>
            הכל · {Sh(totalSpent)}
          </button>
          {PAYER_ORDER.map((p) => (
            <button key={p} type="button" onClick={() => setPayerFilter(payerFilter === p ? "all" : p)} className="rounded-full px-3 py-1.5 text-xs font-medium transition-colors" style={payerFilter === p ? { background: PAYER_COLOR[p], color: "#fff" } : { background: PAYER_BG[p], color: PAYER_COLOR[p] }}>
              {PAYER_LABEL[p]} · {Sh(spentByPayer[p] ?? 0)}
            </button>
          ))}
          <select className="mr-auto rounded-full border border-[var(--hob-rule-strong)] bg-[var(--hob-surface)] px-2.5 py-1 text-xs text-[var(--hob-soft)]" value={catFilter} onChange={(e) => setCatFilter(e.target.value)}>
            <option value="all">כל הקטגוריות</option>
            {[...new Set(expenses.map((e) => e.category))].sort().map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
        {(() => {
          const filtered = expenses.filter((e) => (payerFilter === "all" || e.payer === payerFilter) && (catFilter === "all" || e.category === catFilter));
          // Expenses arrive date-DESC, so months come out newest-first.
          const months: { key: string; rows: Expense[]; total: number }[] = [];
          for (const e of filtered) {
            const key = e.date.slice(0, 7);
            let m = months[months.length - 1];
            if (!m || m.key !== key) {
              m = { key, rows: [], total: 0 };
              months.push(m);
            }
            m.rows.push(e);
            m.total += e.amount;
          }
          if (filtered.length === 0) return <p className="py-3 text-center text-[12px] text-[var(--hob-faint)]">{expenses.length === 0 ? "עוד לא נרשמו הוצאות." : "אין הוצאות שמתאימות לסינון."}</p>;
          return months.map((m) => (
            <Fragment key={m.key}>
              <div className="mt-2 flex items-baseline justify-between rounded-md bg-[var(--hob-bg2)] px-2.5 py-1.5 text-[12px] first:mt-0">
                <b className="text-[var(--hob-ink)]">{monthLabel(m.key)}</b>
                <span className="text-[var(--hob-soft)]">
                  {m.rows.length} הוצאות · <b className="text-[#e2445c]">{Sh(m.total)}</b>
                </span>
              </div>
              {m.rows.map((e) => (
                <div key={e.id} className="group flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-[var(--hob-hover)] py-2 pr-2 text-sm last:border-0" style={{ borderRight: `3px solid ${PAYER_COLOR[e.payer] ?? "#d0d4e4"}` }}>
                  <span className="w-11 shrink-0 text-xs text-[var(--hob-faint)] sm:w-20" dir="ltr">
                    <span className="sm:hidden">{shortDate(e.date)}</span>
                    <span className="hidden sm:inline">{e.date.split("-").reverse().join("/")}</span>
                  </span>
                  <span className="shrink-0 rounded-full px-2 py-0.5 text-xs font-medium" style={{ background: PAYER_BG[e.payer] ?? "#eceff8", color: PAYER_COLOR[e.payer] ?? "#676879" }}>
                    {PAYER_LABEL[e.payer] ?? e.payer}
                  </span>
                  <span className="min-w-0 shrink truncate font-medium text-[var(--hob-ink)]">{e.category}</span>
                  {e.payer === "business" && <PotCell value={e.paid_from ?? ""} onPick={(paidFrom) => mutate.mutate({ op: "set_expense_paid_from", id: e.id, paidFrom })} />}
                  {/* Zero-height full-width spacer = a deterministic line break on a phone. */}
                  <span className="h-0 w-full sm:hidden" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--hob-soft)] sm:text-sm">{e.description}</span>
                  <span className="ms-auto flex shrink-0 items-center gap-2 sm:ms-0">
                    <b className="shrink-0 text-[#e2445c]">{Sh(e.amount)}</b>
                    {attaching ? (
                      <button
                        type="button"
                        onClick={async () => {
                          await fetch(`/api/receipt?attach=${attaching}&expense_id=${e.id}`, { method: "POST" });
                          setAttaching(null);
                          qc.invalidateQueries({ queryKey: ["finance"] });
                        }}
                        className="shrink-0 rounded-md bg-[var(--hob-accent)] px-2 py-0.5 text-[11px] font-medium text-[var(--hob-accent-fg)]"
                      >
                        צרפו כאן
                      </button>
                    ) : (
                      <ReceiptCell expenseId={e.id} receipts={receiptsByExpense.get(e.id) ?? []} onView={setViewReceipt} onChanged={() => qc.invalidateQueries({ queryKey: ["finance"] })} camera={cameraMode} />
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        if (confirmDelete === e.id) {
                          mutate.mutate({ op: "delete_expense", id: e.id });
                          setConfirmDelete(null);
                        } else setConfirmDelete(e.id);
                      }}
                      className={`shrink-0 rounded px-1.5 text-xs ${confirmDelete === e.id ? "bg-[#e2445c] text-white" : "text-[var(--hob-faint)] hover:text-[#e2445c]"}`}
                    >
                      {confirmDelete === e.id ? "בטוח?" : "✕"}
                    </button>
                  </span>
                </div>
              ))}
            </Fragment>
          ));
        })()}
      </div>

      {/* Budgets per category. The list is the partners' own. */}
      <div className="mb-4 rounded-xl bg-[var(--hob-surface)] p-4 shadow-sm">
        <h3 className="mb-1 text-base font-bold text-[var(--hob-ink)]">📊 תקציב מול ביצוע</h3>
        <p className="mb-2 text-xs text-[var(--hob-faint)]">🟢 מתחת ל-70% · 🟡 70-90% · 🔴 מעל 90% — עוצרות ובודקות לפני הוצאה נוספת. לחיצה על סכום התקציב עורכת אותו.</p>
        {budgets.length === 0 && <p className="py-2 text-[12px] text-[var(--hob-faint)]">עוד אין קטגוריות. הוסיפו את הראשונה (למשל ייצור, משלוחים, שיווק) ואז אפשר לרשום הוצאות.</p>}
        {budgets.map((b) => (
          <BudgetRow key={b.category} budget={b} spent={spentByCat.get(b.category) ?? 0} onSetBudget={(category, amount) => mutate.mutate({ op: "set_budget", category, amount })} onDelete={(category) => mutate.mutate({ op: "delete_budget", category })} />
        ))}
        <div className="mt-2 flex gap-2 border-t border-[var(--hob-hover)] pt-2">
          <input
            placeholder="קטגוריה חדשה"
            className={`flex-1 ${inputCls}`}
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              const c = newCategory.trim().slice(0, 60);
              if (!c) return;
              mutate.mutate({ op: "set_budget", category: c, amount: 0 });
              setNewCategory("");
            }}
          />
          <button
            type="button"
            disabled={!newCategory.trim() || mutate.isPending}
            onClick={() => {
              const c = newCategory.trim().slice(0, 60);
              if (!c) return;
              mutate.mutate({ op: "set_budget", category: c, amount: 0 });
              setNewCategory("");
            }}
            className="rounded-md bg-[var(--hob-hover)] px-4 py-2 text-sm text-[var(--hob-soft)] hover:bg-[var(--hob-rule)] disabled:opacity-50"
          >
            ➕ הוספה
          </button>
        </div>
      </div>

      <Simulator scenarios={data?.scenarios ?? []} vatExempt={vatExempt} onSave={(name, scenarioData) => mutate.mutate({ op: "save_scenario", name, data: scenarioData })} onDelete={(name) => mutate.mutate({ op: "delete_scenario", name })} />

      {viewReceipt !== null && (
        <ReceiptViewer
          id={viewReceipt}
          expense={(() => {
            const r = (data?.receipts ?? []).find((x) => x.id === viewReceipt);
            return r?.expense_id ? (data?.expenses ?? []).find((e) => e.id === r.expense_id) : undefined;
          })()}
          onClose={() => setViewReceipt(null)}
          onDeleted={() => {
            setViewReceipt(null);
            qc.invalidateQueries({ queryKey: ["finance"] });
          }}
        />
      )}
    </div>
  );
}
