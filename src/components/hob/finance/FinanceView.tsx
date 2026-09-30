// 💰 Finance tab: shared expense log, live budget-vs-actual with traffic
// lights, and an interactive profit simulator — the web version of the
// partners' SEGULA-כספים.xlsx workbook.
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isDemo } from "../demo";
import { parseMoney } from "../board";
import { type Figure, figureMeta } from "../../../lib/figure";

import { PaceStrip, TrafficCard } from "./PaceStrip";
import { Simulator } from "./Simulator";
import { BudgetRow, DROP_META, DROP_ORDER, EditableKpi, EditableMoney, Expense, FinanceData, Kpi, NIS, NumField, PAYER_BG, PAYER_COLOR, PAYER_LABEL, PAYER_NEW, PAYER_ORDER, PAY_LABEL, POCKET_PAYERS, PAY_ORDER, POT_LABEL, POT_OF_PAY, POT_ORDER, PROVIDERS, PROVIDER_LABEL, PotCell, Receipt, ReceiptCell, ReceiptViewer, SettlementBox, Sh, api, todayISO } from "./shared";

export function FinanceView({ actor, onAuthLost }: { actor: string; onAuthLost: () => void }) {
  const qc = useQueryClient();
  const query = useQuery<FinanceData, Error>({
    queryKey: ["finance"],
    queryFn: () => api(),
    refetchInterval: 30_000, // was 15s — a dozen queries per poll
    // No backoff dance on an expired session — straight to the login screen.
    retry: (count, error) => error.message !== "unauthorized" && count < 2,
  });
  useEffect(() => {
    if (query.error?.message === "unauthorized") onAuthLost();
  }, [query.error, onAuthLost]);

  const mutate = useMutation({
    mutationFn: (body: Record<string, unknown>) => api(body),
    onSettled: () => qc.invalidateQueries({ queryKey: ["finance"] }),
  });

  const [form, setForm] = useState(() => ({
    amount: "",
    category: "",
    description: "",
    date: todayISO(),
    payer: actor || "business",
    // Which pot a business expense came out of — the last choice sticks, the
    // same way the pop-up sale form remembers its payment method.
    paidFrom: (typeof localStorage !== "undefined" && localStorage.getItem("hob_pot")) || "cash",
  }));
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [payerFilter, setPayerFilter] = useState<string>("all");
  const [catFilter, setCatFilter] = useState<string>("all");
  // Which breakdown is open under the in/out cards — one at a time, so the
  // header card never grows into a wall of chips.
  const [openBreakdown, setOpenBreakdown] = useState<"in" | "out" | null>(null);
  // The register panel opens from its own card further down the page.
  // ?log=settlement (הקישור "רשום הפקדה" מ"היום שלך") פותח אותו ישר על רישום הזיכוי.
  const [logSettlement] = useState(
    () => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("log") === "settlement",
  );
  const [openPots, setOpenPots] = useState(logSettlement);
  const settlementRef = useRef<HTMLDivElement>(null);
  const scrolledToSettlement = useRef(false);
  useEffect(() => {
    if (!logSettlement || scrolledToSettlement.current || !settlementRef.current) return;
    scrolledToSettlement.current = true;
    settlementRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    // רענון הדף לא יפתח שוב: הפרמטר יורד מהכתובת אחרי שימוש אחד.
    const url = new URL(window.location.href);
    url.searchParams.delete("log");
    window.history.replaceState(null, "", url);
  });
  const [viewReceipt, setViewReceipt] = useState<number | null>(null);
  // A receipt picked from the pending strip, waiting for an expense to land on.
  const [attaching, setAttaching] = useState<number | null>(null);
  // On a desktop the camera appears on row hover; a phone has no hover, so
  // this toggle brings it out for as long as it is needed.
  const [cameraMode, setCameraMode] = useState(false);
  // "מאז הרכישה" מול "הכל". null = אוטומטי: מאז הרכישה ברגע שיש תאריך חתימה.
  const [rangePick, setRangePick] = useState<"era" | "all" | null>(null);

  const data = query.data;
  // הרכישה מדימה (27.9): מיום החתימה הכסף של יוגב. "מאז הרכישה" חותך את ההכנסות,
  // ההוצאות, הזיכויים ויתרות הפתיחה לפי התאריך; "הכל" מציג את כל התקופה כמו קודם.
  // התקציב לפי קטגוריה והתקציב מהכיס נשארים על כל התקופה: הם תוכנית אחת רציפה.
  const buyoutDate = data?.buyoutDate ?? "";
  const eraOn = !!buyoutDate && rangePick !== "all";
  const allExpenses = useMemo(() => data?.expenses ?? [], [data]);
  const expenses = useMemo(
    () => (eraOn ? allExpenses.filter((e) => e.date >= buyoutDate) : allExpenses),
    [allExpenses, eraOn, buyoutDate],
  );
  const spentByCat = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of allExpenses) m.set(e.category, (m.get(e.category) ?? 0) + e.amount);
    return m;
  }, [allExpenses]);
  const totalSpent = expenses.reduce((s, e) => s + e.amount, 0);
  const spentByPayer = useMemo(() => {
    const m: Record<string, number> = { yogev: 0, yogev_buyout: 0, business: 0 };
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
  // Receipts nobody has hung on an expense yet — usually a photo sent to Bruno
  // before (or instead of) the amount.
  const pending = (data?.receipts ?? []).filter((r) => r.expense_id == null);
  const totalBudget = data?.totalBudget ?? 60000;
  // Two separate pots. The budget is what goes in from Yogev's own pocket
  // (including what came to him with the buyout of Dima's share) — an expense
  // the business paid out of sales money never touched it, so measuring the
  // budget against every expense made the bar scream "almost out" for the
  // wrong reason. Anything not paid from the pocket counts as the business pot.
  const pocketSpent = POCKET_PAYERS.reduce((s, p) => s + (spentByPayer[p] ?? 0), 0);
  const businessSpent = totalSpent - pocketSpent;
  // התקציב מהכיס נמדד תמיד על כל התקופה, גם כשהמסך מציג רק מאז הרכישה.
  const pocketSpentAll = allExpenses
    .filter((e) => (POCKET_PAYERS as readonly string[]).includes(e.payer))
    .reduce((s, e) => s + e.amount, 0);
  const utilization = totalBudget > 0 ? pocketSpentAll / totalBudget : 0;

  const savingExpense = useRef(false);
  const submit = () => {
    if (savingExpense.current || mutate.isPending) return;
    const amount = parseMoney(form.amount);
    if (!(amount > 0) || !form.category) return;
    if (form.payer === "business" && typeof localStorage !== "undefined") {
      localStorage.setItem("hob_pot", form.paidFrom);
    }
    savingExpense.current = true;
    const submitted = { ...form };
    mutate.mutate({
      op: "add_expense",
      date: form.date,
      payer: form.payer,
      category: form.category,
      description: form.description,
      amount,
      paidFrom: form.payer === "business" ? form.paidFrom : "",
      actor,
    }, {
      onSuccess: () => setForm((f) =>
        Object.keys(submitted).every((key) => f[key as keyof typeof f] === submitted[key as keyof typeof submitted])
          ? { ...f, amount: "", description: "" } : f),
      onSettled: () => { savingExpense.current = false; },
    });
  };

  if (query.isLoading) return <div className="py-24 text-center text-[var(--hob-faint)]">טוען את הכספים…</div>;
  if (query.isError && !query.data) return <div className="py-24 text-center text-[#e2445c]">שגיאה בטעינה — נסו לרענן.</div>;

  const revenue = eraOn ? data?.revenueSince : data?.revenue;
  const grossRevenue = revenue?.gross ?? 0;
  const salesCount = revenue?.orders ?? 0;
  // Where the money is. Almost everything comes through the store, so the
  // split only earns its space once some shekels arrived another way.
  const byMethod = revenue?.byMethod ?? {};
  const payRows = PAY_ORDER.map((key) => ({ key, amount: byMethod[key] ?? 0 })).filter(
    (r) => r.amount > 0,
  );
  // Tagged non-store money only. An untagged row is money nobody attributed
  // yet — counting it as "outside the store" would be a guess.
  const outsideStore = payRows
    .filter((r) => r.key !== "shopify" && r.key !== "")
    .reduce((s, r) => s + r.amount, 0);
  const untagged = byMethod[""] ?? 0;
  // עוסק פטור: no VAT is charged or remitted — every shekel of revenue is theirs.
  const realProfit = grossRevenue - totalSpent;
  const settlements = (data?.settlements ?? []).filter((s) => !eraOn || s.date >= buyoutDate);
  const feeRates = data?.feeRates ?? { shopify: 0.024, hyp: 0.02 };
  // Per provider: how much gross a deposit has already closed, and how much
  // net it actually put in the bank. The difference is the clearer's cut —
  // money the business earned and will never see, so it leaves the register.
  // Deliberately NOT useMemo: this sits below the isLoading/isError early
  // returns, so a hook here would change the hook count between renders
  // (React #310). It is a fold over a handful of rows — memoising it is noise.
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
      // The rate the partners are really paying, once there is a deposit to
      // read it off — this is what should replace the estimate over time.
      m[p].rate = m[p].gross > 0 ? m[p].fee / m[p].gross : 0;
    }
    return m;
  })();
  const feesPaid = PROVIDERS.reduce((s, p) => s + clearing[p].fee, 0);
  const settledNet = PROVIDERS.reduce((s, p) => s + clearing[p].net, 0);
  // What is actually sitting in the register, and how much of the partners' own
  // money it could pay back. Measuring recovery against revenue-minus-everything
  // subtracted their own investment from its own return. Clearing fees come off
  // the top: they were never the business's money to hold.
  // Money that was already in the account before the ledger starts describing
  // it — real business money, just not traceable to a sale.
  // מאז הרכישה: היתרות של החשבון החדש ביום החתימה. אחרת: יתרות הפתיחה הישנות.
  const newOpenings = data?.newOpenings ?? { bank: null, bit: null, cash: null };
  const bankOpening = eraOn ? (newOpenings.bank ?? 0) : (data?.bankOpening ?? 0);
  // אותו רעיון לביט ולמזומן (null = לא הוזן). השרת (moneySnapshot) כבר מחשב איתם.
  const bitOpening = eraOn ? newOpenings.bit : (data?.bitOpening ?? null);
  const cashOpening = eraOn ? newOpenings.cash : (data?.cashOpening ?? null);
  const businessCash = grossRevenue - businessSpent - feesPaid + bankOpening + (bitOpening ?? 0) + (cashOpening ?? 0);
  const recovery = pocketSpent > 0 ? businessCash / pocketSpent : 0;
  // What is left in each pot. A card sale enters its provider's "on its way"
  // pot and only moves to the bank when a settlement records the deposit — so
  // the bank row is a number that can be checked against the bank statement.
  // Rows still sum to businessCash, so the panel reconciles with its card.
  const potRows = (() => {
    const inn: Record<string, number> = { bank: 0, p_shopify: 0, p_hyp: 0, bit: 0, cash: 0, "": 0 };
    for (const [method, amount] of Object.entries(byMethod)) {
      inn[POT_OF_PAY[method] ?? ""] += amount;
    }
    // Settled money leaves the waiting pot in gross and lands in the bank in net.
    for (const p of PROVIDERS) {
      inn[p === "shopify" ? "p_shopify" : "p_hyp"] -= clearing[p].gross;
    }
    inn.bank += settledNet + bankOpening;
    inn.bit += bitOpening ?? 0;
    inn.cash += cashOpening ?? 0;
    const out: Record<string, number> = { bank: 0, p_shopify: 0, p_hyp: 0, bit: 0, cash: 0, "": 0 };
    for (const e of expenses) {
      if (e.payer !== "business") continue;
      // Only bank/bit/cash can ever pay for something — nothing is spent
      // straight out of a clearer's balance.
      const pot = ["bank", "bit", "cash"].includes(e.paid_from ?? "") ? (e.paid_from as string) : "";
      out[pot] += e.amount;
    }
    const keys = [...POT_ORDER, ""].filter((k) =>
      k === "p_shopify" || k === "p_hyp" || k === "" ? Math.abs(inn[k]) > 0.5 || out[k] > 0 : true,
    );
    return keys.map((key) => ({ key, inn: inn[key] ?? 0, out: out[key] ?? 0, left: (inn[key] ?? 0) - (out[key] ?? 0) }));
  })();
  // "כמה כסף יש": מתמונת הכסף של השרת (moneySnapshot), לא מחישוב בדפדפן. כל רכיב מגיע עם
  // מקור, מצב ונכון-למתי. בנק שלא אומת (זיכוי אחרון לפני יותר משבועיים, או בלי יתרת פתיחה)
  // לא מוצג ככסף פנוי בטוח: הכותרת אומרת שזו יתרה לפי הרישומים.
  const money = data?.money ?? null;
  const bankFig = money?.balances.bank ?? null;
  const bankVerified = bankFig !== null && bankFig.value !== null && bankFig.state === "verified" && !bankFig.note;
  const balanceParts = money ? [money.balances.bank, money.balances.bit, money.balances.cash] : [];
  const balancesKnown = money !== null && balanceParts.every((f) => f.value !== null);
  const availableCash = balancesKnown ? balanceParts.reduce((s, f) => s + (f.value ?? 0), 0) : null;
  const pendingCash = money?.receivables.clearing.value ?? null;
  const unassignedCash = potRows.find((r) => r.key === "")?.left ?? 0;
  const bankAsOfHe = bankFig?.asOf ? `${Number(bankFig.asOf.slice(8, 10))}.${Number(bankFig.asOf.slice(5, 7))}` : "אף פעם";
  // "כמה כסף יש" הוא תמיד הכסף של היום: אחרי החתימה — החשבון החדש, בכל תצוגה.
  const eraHe = buyoutDate ? `${Number(buyoutDate.slice(8, 10))}.${Number(buyoutDate.slice(5, 7))}` : "";
  const cashLabelBase = money === null ? "זמין בבנק, ביט ומזומן" : bankVerified ? "זמין בבנק, ביט ומזומן" : `יתרה לפי הרישומים, לא אומתה מול הבנק מ-${bankAsOfHe}`;
  const cashLabel = buyoutDate ? `${cashLabelBase} · החשבון החדש, מאז ${eraHe}` : cashLabelBase;
  const figureRows: { label: string; f: Figure }[] = money
    ? [
        { label: "בנק", f: money.balances.bank },
        { label: "ביט", f: money.balances.bit },
        { label: "מזומן", f: money.balances.cash },
        { label: "מחכה אצל הסולקים", f: money.receivables.clearing },
        { label: "כסף פנוי", f: money.free },
      ]
    : [];
  const untaggedOut = potRows.find((r) => r.key === "")?.out ?? 0;
  // Still-in-transit gross per provider, plus what it should net at the
  // current estimated rate — the "expect roughly this much" line.
  const inTransit = PROVIDERS.map((p) => {
    const gross = (byMethod[p] ?? 0) - clearing[p].gross;
    // Once a real deposit exists, its rate beats the typed estimate.
    const rate = clearing[p].rate > 0 ? clearing[p].rate : (feeRates[p] ?? 0);
    return { provider: p, gross, rate, net: gross * (1 - rate), actual: clearing[p].rate > 0 };
  }).filter((r) => Math.abs(r.gross) > 0.5);

  return (
    <div className="mx-auto max-w-3xl">
      {/* הרכישה מדימה: יום החתימה חותך את הכסף לשתי תקופות. בלי תאריך הכל תקופה אחת. */}
      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl bg-[var(--hob-surface)] px-4 py-2.5 text-[13px] shadow-sm">
        <span className="font-bold text-[var(--hob-ink)]">🤝 יום החתימה על הרכישה:</span>
        <input
          type="date"
          defaultValue={buyoutDate}
          key={`bd-${buyoutDate}`}
          onChange={(e) => {
            const v = e.target.value;
            if ((v === "" || /^\d{4}-\d{2}-\d{2}$/.test(v)) && v !== buyoutDate) {
              setRangePick(null);
              mutate.mutate({ op: "set_buyout_date", day: v });
            }
          }}
          className="hob-mono h-8 rounded-md border border-[var(--hob-rule)] bg-transparent px-2 outline-none focus:border-[var(--hob-accent)]"
        />
        {buyoutDate ? (
          <div className="ms-auto flex gap-1">
            {([
              ["era", "מאז הרכישה"],
              ["all", "הכל"],
            ] as const).map(([k, lbl]) => (
              <button
                key={k}
                type="button"
                onClick={() => setRangePick(k)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  (k === "era") === eraOn ? "bg-[var(--hob-ink)] text-white" : "bg-[var(--hob-hover)] text-[var(--hob-soft)]"
                }`}
              >
                {lbl}
              </button>
            ))}
          </div>
        ) : (
          <span className="text-[11.5px] text-[var(--hob-faint)]">
            עוד לא נחתם. ביום החתימה מסמנים כאן את התאריך, ומאותו יום ההכנסות, ההוצאות והקופות נספרים בנפרד.
          </span>
        )}
      </div>

      {/* In vs out — the real cash picture */}
      <div className="mb-3 rounded-xl bg-[var(--hob-surface)] p-4 shadow-sm">
        <div className="mb-2 flex items-baseline justify-between">
          <h3 className="text-base font-bold text-[var(--hob-ink)]">⚖️ נכנס מול יצא</h3>
          <span className="text-[11px] text-[var(--hob-faint)]">הפדיון נמשך אוטומטית מרישומי המכירות + הזמנות Shopify</span>
        </div>
        <div className="flex flex-wrap gap-3">
          <Kpi
            label="נכנס — פדיון"
            value={Sh(grossRevenue)}
            accent="#00854d"
            sub={`${salesCount} מכירות · עוסק פטור — בלי מע"מ`}
            onClick={payRows.length > 0 ? () => setOpenBreakdown((p) => (p === "in" ? null : "in")) : undefined}
            open={openBreakdown === "in"}
          />
          <Kpi
            label="יצא — הוצאות"
            value={Sh(totalSpent)}
            accent="#e2445c"
            sub={pocketSpent > 0 && businessSpent > 0 ? "מהכיס + מקופת העסק" : businessSpent > 0 ? "הכל מקופת העסק" : "הכל מהכיס של יוגב"}
            onClick={totalSpent > 0 ? () => setOpenBreakdown((p) => (p === "out" ? null : "out")) : undefined}
            open={openBreakdown === "out"}
          />
          <Kpi
            label="פדיון פחות הוצאות רשומות"
            value={Sh(realProfit)}
            accent={realProfit >= 0 ? "#00854d" : "#e2445c"}
            sub="לפני התאמת עמלות סליקה · לא יתרת מזומן"
          />
        </div>
        {openBreakdown === "in" && (
          <div className="mt-3 rounded-lg bg-[var(--hob-bg2)] p-2.5">
            <div className="mb-1.5 flex items-baseline justify-between">
              <b className="text-[13px] text-[var(--hob-ink)]">💰 מאיפה נכנס הכסף</b>
              <span className="text-[11px] text-[var(--hob-faint)] dm-block">
                {outsideStore > 0
                  ? `${NIS(outsideStore)} התקבלו מחוץ לאתר`
                  : untagged > 0
                    ? `${NIS(untagged)} עדיין בלי סימון`
                    : "הכל נכנס דרך האתר"}
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {payRows.map((r) => (
                <span
                  key={r.key || "none"}
                  className="rounded-full px-2.5 py-1 text-[12px] font-medium text-white"
                  style={{ backgroundColor: PAY_LABEL[r.key].color }}
                >
                  {PAY_LABEL[r.key].label} · {Sh(r.amount)}
                </span>
              ))}
            </div>
            {untagged > 0 && (
              <div className="mt-1.5 text-[11px] text-[var(--hob-faint)]">
                מכירות בלי סימון תשלום — אפשר לתייג בלחיצה בטאב 🎁 חלוקות
              </div>
            )}
          </div>
        )}
        {openBreakdown === "out" && (
          <div className="mt-3 rounded-lg bg-[var(--hob-bg2)] p-2.5">
            <div className="mb-1.5 flex items-baseline justify-between">
              <b className="text-[13px] text-[var(--hob-ink)]">🧾 מי הוציא</b>
              <span className="text-[11px] text-[var(--hob-faint)] dm-block">
                {businessSpent > 0
                  ? `מהכיס של יוגב ${NIS(pocketSpent)} · מקופת העסק ${NIS(businessSpent)}`
                  : `מהכיס של יוגב ${NIS(pocketSpent)}`}
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {PAYER_ORDER.filter((p) => (spentByPayer[p] ?? 0) > 0).map((p) => (
                <span
                  key={p}
                  className="rounded-full px-2.5 py-1 text-[12px] font-medium text-white"
                  style={{ backgroundColor: PAYER_COLOR[p] }}
                >
                  {PAYER_LABEL[p]} · {Sh(spentByPayer[p] ?? 0)}
                </span>
              ))}
            </div>
            <div className="mt-1.5 text-[11px] text-[var(--hob-faint)]">
              התקציב של <span className="dm">{NIS(totalBudget)}</span> נמדד רק על מה שיצא מהכיס של יוגב, כולל מה שהגיע עם הרכישה. הוצאות העסק משולמות
              מהמכירות. פירוט מלא לפי קטגוריה ומשלם ביומן ההוצאות למטה.
            </div>
          </div>
        )}
        {!eraOn && (
        <div className="mt-3">
          <div className="mb-1 flex justify-between text-[11px] text-[var(--hob-soft)]">
            <span className="dm-block">החזר ההשקעה — מתוך {NIS(pocketSpent)} שהוזרמו מהכיס</span>
            <b className="dm" style={{ color: recovery >= 0 ? "#00854d" : "#e2445c" }}>{Math.round(recovery * 100)}%</b>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--hob-hover)]">
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${Math.max(0, Math.min(1, recovery)) * 100}%`,
                background: "#00854d",
              }}
            />
          </div>
          <div className="mt-1 text-[11px] text-[var(--hob-faint)] dm-block">
            {businessCash >= 0
              ? `יתרה כולל כספים בדרך ${NIS(businessCash)} — לאחר עמלות סליקה שנרשמו`
              : `יתרה כולל כספים בדרך ${NIS(businessCash)} — נדרשת התאמת הקופות`}
          </div>
        </div>
        )}
        {eraOn && (
          <div className="mt-3 text-[11px] text-[var(--hob-faint)] dm-block">
            {`מאז החתימה (${Number(buyoutDate.slice(8, 10))}.${Number(buyoutDate.slice(5, 7))}): יתרה כולל כספים בדרך ${NIS(businessCash)}. החזר ההשקעה מוצג תחת "הכל".`}
          </div>
        )}
      </div>

      <PaceStrip pulse={data?.pulse} totalSpent={totalSpent} grossRevenue={grossRevenue} />
      <TrafficCard />

      {/* Profit per drop — did each drop actually make money. Revenue is the
          ledger's truth; the production cost is the partners' own figure,
          typed once per drop (tap the cost to edit). */}
      {(data?.dropProfits?.length ?? 0) > 0 && (
        <div className="mb-3 rounded-xl bg-[var(--hob-surface)] p-4 shadow-sm">
          <div className="mb-2 flex items-baseline justify-between">
            <h3 className="text-base font-bold text-[var(--hob-ink)]">📈 רווח לפי דרופ</h3>
            <span className="text-[11px] text-[var(--hob-faint)]">הכנסות אמיתיות מול העלויות שאתם מזינים</span>
          </div>
          <div className="space-y-2">
            {DROP_ORDER.map((key) => {
              const d = data?.dropProfits?.find((p) => p.collection === key);
              if (!d) return null;
              // Empty unassigned bucket is noise, and side items with no cost
              // and no sales say nothing — show a row only when it has data.
              if (d.units === 0 && d.cost === 0 && (d.totalCost ?? 0) === 0 && d.stockValue === 0) return null;
              const meta = DROP_META[key] ?? DROP_META[""];
              // Profit is measured against the all-in cost when it was typed,
              // otherwise against production cost — never against 0.
              const baseCost = (d.totalCost ?? 0) > 0 ? (d.totalCost as number) : d.cost;
              const profit = d.revenue - baseCost;
              const covered = baseCost > 0 ? Math.min(100, Math.round((d.revenue / baseCost) * 100)) : null;
              return (
                <div
                  key={key}
                  className="rounded-lg border border-[var(--hob-rule)] p-3"
                  style={{ borderInlineStart: `4px solid ${meta.color}` }}
                >
                  <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-sm font-bold" style={{ color: meta.color }}>
                      {meta.label}
                    </span>
                    <span className={`dm text-sm font-bold ${profit >= 0 ? "text-[var(--hob-good)]" : "text-[#e2445c]"}`}>
                      {baseCost > 0 ? (profit >= 0 ? `רווח ${NIS(profit)}` : `${NIS(profit)} עד איזון`) : "‏"}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-[var(--hob-soft)]">
                    <span className="dm-block">
                      נמכר: <b className="text-[var(--hob-ink)]">{d.units}</b> יח' · <b className="text-[var(--hob-ink)]">{NIS(d.revenue)}</b>
                    </span>
                    <span className="dm-block">
                      על המדף עוד <b className="text-[var(--hob-ink)]">{NIS(d.stockValue)}</b>
                    </span>
                    <span className="flex items-center gap-1 dm-block">
                      עלות ייצור:
                      <EditableMoney
                        value={d.cost}
                        onSave={(v) => mutate.mutate({ op: "set_drop_cost", collection: key, amount: v, kind: "prod" })}
                      />
                    </span>
                    <span className="flex items-center gap-1 dm-block">
                      עלות כללית:
                      <EditableMoney
                        value={d.totalCost ?? 0}
                        onSave={(v) => mutate.mutate({ op: "set_drop_cost", collection: key, amount: v, kind: "total" })}
                      />
                    </span>
                  </div>
                  {covered !== null && (
                    <div className="mt-2">
                      <div className="h-1.5 overflow-hidden rounded-full bg-[var(--hob-hover)]">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${covered}%`,
                            backgroundColor: covered >= 100 ? "#00854d" : meta.color,
                          }}
                        />
                      </div>
                      <div className="mt-0.5 text-[11px] text-[var(--hob-faint)] dm-block">
                        {covered >= 100
                          ? "הפדיון כיסה את העלות שהוזנה · לפני עלויות נוספות"
                          : `הוחזרו ${covered}% ${(d.totalCost ?? 0) > 0 ? "מהעלות הכללית" : "מעלות הייצור"}`}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* KPIs — the per-payer split lives under the "יצא" card above */}
      <div className="mb-4 flex flex-wrap gap-3">
        <EditableKpi
          label="תקציב מהכיס של יוגב (לחיצה לעריכה)"
          amount={totalBudget}
          onSave={(amount) => mutate.mutate({ op: "set_total_budget", amount })}
          sub="לא כולל הוצאות העסק"
        />
        <Kpi
          label="נותר להשקיע"
          value={Sh(totalBudget - pocketSpentAll)}
          accent="#00854d"
          sub="מהכיס, בלי הוצאות העסק"
        />
        <Kpi
          label="ניצול תקציב"
          value={<span className="dm">{Math.round(utilization * 100)}%</span>}
          sub={`${NIS(pocketSpentAll)} מתוך ${NIS(totalBudget)}`}
          accent={utilization >= 0.9 ? "#e2445c" : utilization >= 0.7 ? "#fdab3d" : "#00854d"}
        />
        <Kpi
          label={cashLabel}
          value={availableCash === null ? <span className="text-[15px]">{money === null ? "לא נבדק" : "לא ידוע"}</span> : Sh(availableCash)}
          accent={money === null || availableCash === null ? "#fdab3d" : bankVerified ? (availableCash >= 0 ? "#00854d" : "#e2445c") : "#fdab3d"}
          sub={
            money === null
              ? "תמונת הכסף לא נטענה. זה לא אומר אפס"
              : `${pendingCash === null ? "בדרך בסליקה: לא ידוע" : `בדרך בסליקה: ${NIS(pendingCash)} ברוטו`}${money.free.value !== null ? ` · כסף פנוי: ${NIS(money.free.value)}` : ` · כסף פנוי: לא מחושב`}${Math.abs(unassignedCash) > 0.005 ? ` · לא משויך: ${NIS(unassignedCash)}` : ""}`
          }
          onClick={() => setOpenPots((p) => !p)}
          open={openPots}
        />
      </div>

      {/* מקור · עודכן לכל מספר חשוב, בגלוי ולא בטולטיפ: מה זה, מאיפה, מתי, ומה מצב האמינות. */}
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
                <span
                  className="shrink-0 rounded-full px-2.5 py-1 text-[12px] font-medium text-white"
                  style={{ backgroundColor: POT_LABEL[r.key].color }}
                >
                  {POT_LABEL[r.key].label}
                </span>
                <span className="min-w-0 truncate text-[11px] text-[var(--hob-faint)] dm-block">
                  נכנס {NIS(r.inn)} · יצא {NIS(r.out)}
                </span>
                <b
                  className="mr-auto shrink-0 text-[17px]"
                  style={{ color: r.left > 0 ? "#00854d" : r.left < 0 ? "#e2445c" : "#676879" }}
                >
                  {Sh(r.left)}
                </b>
              </div>
            ))}
          </div>
          <div className="mt-2 flex justify-between border-t border-[var(--hob-hover)] pt-2 text-[12px] text-[var(--hob-soft)]">
            <span>סה"כ כולל כספים בדרך</span>
            <b style={{ color: businessCash >= 0 ? "#00854d" : "#e2445c" }}>{Sh(businessCash)}</b>
          </div>
          <div className="mt-1.5 text-[11px] text-[var(--hob-faint)]">
            שורת הבנק = רק זיכויים שבאמת נחתו בחשבון, בנטו — אפשר להשוות אותה מול דף הבנק · הוצאות מהכיס של יוגב
            לא נוגעות בקופות האלה
            {untaggedOut > 0 && (
              <>
                {" · "}
                <b className="text-[#fdab3d] dm-block">{NIS(untaggedOut)} בלי סימון מאיפה שולם</b> — אפשר לתייג בלחיצה
                ביומן ההוצאות למטה
              </>
            )}
          </div>

          {/* What is still at the clearer, and what it should net */}
          {inTransit.length > 0 && (
            <div className="mt-3 rounded-lg bg-[var(--hob-bg2)] p-2.5">
              <b className="text-[12px] text-[var(--hob-ink)]">⏳ כסף שעוד לא הגיע לבנק</b>
              <div className="mt-1.5 grid gap-1">
                {inTransit.map((r) => (
                  <div key={r.provider} className="flex flex-wrap items-baseline gap-x-2 text-[12px]">
                    <span className="font-medium text-[var(--hob-ink)]">{PROVIDER_LABEL[r.provider]}</span>
                    <span className="text-[var(--hob-faint)]">
                      ברוטו <span className="dm">{NIS(r.gross)}</span> · עמלה {(r.rate * 100).toFixed(2)}%
                      {r.actual ? " (לפי הזיכויים שלך)" : " (הערכה)"}
                    </span>
                    <b className="mr-auto text-[13px] text-[var(--hob-ink)]">≈ {Sh(r.net)}</b>
                  </div>
                ))}
              </div>
              <div className="mt-1.5 text-[11px] text-[var(--hob-faint)]">
                זה הסכום שאמור להיכנס לבנק. כשהוא נכנס — רשמו אותו למטה והלוח יחשב את העמלה האמיתית לבד.
              </div>
            </div>
          )}

          {/* Log a deposit */}
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
              <span className="text-[var(--hob-soft)]">{eraOn ? "עמלות סליקה ששולמו מאז החתימה" : "סה\"כ עמלות סליקה ששולמו עד היום"}</span>
              <b className="text-[#e2445c] dm-block">{NIS(feesPaid)}</b>
            </div>
          )}

          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-[var(--hob-bg2)] px-2.5 py-2 text-[12px]">
            <span className="text-[var(--hob-soft)]">
              {eraOn ? "בחשבון החדש ביום החתימה" : "יתרת פתיחה בבנק"}
              <span className="mr-1 text-[11px] text-[var(--hob-faint)]">
                {eraOn
                  ? newOpenings.bank === null
                    ? "— לא הוזן: כמה היה בחשבון החדש אחרי החלוקה עם דימה"
                    : "— החלק שלך מהקופה, בחשבון החדש"
                  : "— כסף שהיה בחשבון לפני שהלוח התחיל לעקוב"}
              </span>
            </span>
            <NumField
              label=""
              value={bankOpening}
              unit="₪"
              max={1000000}
              width="w-24"
              onSave={(v) =>
                mutate.mutate(eraOn ? { op: "set_new_opening", pot: "bank", amount: v } : { op: "set_bank_opening", amount: v })
              }
            />
          </div>
          {/* ביט ומזומן: בלי יתרת פתיחה הם רק מה שנרשם בלוח, לא יתרה אמיתית. */}
          {([
            ["bit", eraOn ? "בביט ביום החתימה" : "יתרת פתיחה בביט", bitOpening],
            ["cash", eraOn ? "במזומן ביום החתימה" : "יתרת פתיחה במזומן", cashOpening],
          ] as const).map(([pot, label, value]) => (
            <div key={pot} className="mt-1.5 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-[var(--hob-bg2)] px-2.5 py-2 text-[12px]">
              <span className="text-[var(--hob-soft)]">
                {label}
                <span className="mr-1 text-[11px] text-[var(--hob-faint)]">
                  {value === null
                    ? "לא הוזנה: השורה מציגה רק מה שנרשם בלוח"
                    : eraOn
                      ? "החלק שלך מהקופה ביום החתימה"
                      : "כסף שהיה לפני שהלוח התחיל לעקוב"}
                </span>
              </span>
              <NumField
                label=""
                value={value ?? 0}
                unit="₪"
                max={1000000}
                width="w-24"
                onSave={(v) =>
                  mutate.mutate(eraOn ? { op: "set_new_opening", pot, amount: v } : { op: "set_pot_opening", pot, amount: v })
                }
              />
            </div>
          ))}
        </div>
      )}

      {/* Add expense */}
      <div className="mb-4 rounded-xl bg-[var(--hob-surface)] p-4 shadow-sm">
        <h3 className="mb-2 text-base font-bold text-[var(--hob-ink)]">➕ רישום הוצאה</h3>
        <div className="flex flex-wrap gap-2">
          <input
            dir="ltr"
            inputMode="decimal"
            placeholder="סכום ₪"
            className="w-28 rounded-md border border-[var(--hob-rule-strong)] px-3 py-2 text-right text-lg font-bold focus:border-[#037f4c] focus:outline-none"
            value={form.amount}
            onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
          <select
            className="rounded-md border border-[var(--hob-rule-strong)] bg-[var(--hob-surface)] px-2 py-2 text-sm"
            value={form.category}
            onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
          >
            <option value="">קטגוריה…</option>
            {(data?.budgets ?? []).map((b) => (
              <option key={b.category} value={b.category}>{b.category}</option>
            ))}
          </select>
          <input
            type="date"
            className="rounded-md border border-[var(--hob-rule-strong)] px-2 py-2 text-sm"
            value={form.date}
            onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
          />
          <div className="flex items-center gap-1">
            {PAYER_NEW.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setForm((f) => ({ ...f, payer: p }))}
                className="rounded-full px-3 py-1.5 text-xs transition-colors"
                style={
                  form.payer === p
                    ? { background: PAYER_COLOR[p], color: "#fff" }
                    : { background: "#eceff8", color: "#676879" }
                }
              >
                {PAYER_LABEL[p]}
              </button>
            ))}
          </div>
        </div>
        {form.payer === "business" && (
          <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-[var(--hob-bg2)] p-2.5">
            <span className="text-xs text-[var(--hob-soft)]">מאיפה שולם?</span>
            {POT_ORDER.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setForm((f) => ({ ...f, paidFrom: k }))}
                className="rounded-full px-3 py-1.5 text-xs transition-colors"
                style={
                  form.paidFrom === k
                    ? { background: POT_LABEL[k].color, color: "#fff" }
                    : { background: "#eceff8", color: "#676879" }
                }
              >
                {POT_LABEL[k].label}
              </button>
            ))}
            <span className="text-[11px] text-[var(--hob-faint)]">יורד מהיתרה של אותה קופה</span>
          </div>
        )}
        <div className="mt-2 flex gap-2">
          <input
            placeholder="על מה? (לא חובה)"
            className="flex-1 rounded-md border border-[var(--hob-rule-strong)] px-3 py-2 text-sm focus:border-[#037f4c] focus:outline-none"
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
          <button
            type="button"
            onClick={submit}
            disabled={mutate.isPending}
            className="rounded-md bg-[#037f4c] px-5 py-2 text-sm font-medium text-white hover:bg-[#026b40] disabled:opacity-50"
          >
            רישום
          </button>
        </div>
      </div>

      {/* Expense log */}
      <div className="mb-4 rounded-xl bg-[var(--hob-surface)] p-4 shadow-sm">
        <h3 className="mb-1 text-base font-bold text-[var(--hob-ink)]">🧾 יומן הוצאות (<span className="dm">{expenses.length}</span>)</h3>
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <p className="text-xs text-[var(--hob-faint)]">
            📎 קבלה מצורפת — לחיצה מציגה אותה · הדרך הנוחה לצרף היא לצרף תמונה לברונו בלוח עם הסכום
          </p>
          <button
            type="button"
            onClick={() => setCameraMode((c) => !c)}
            className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
              cameraMode ? "bg-[var(--hob-accent)] text-[var(--hob-accent-fg)]" : "bg-[var(--hob-hover)] text-[var(--hob-soft)]"
            }`}
          >
            {cameraMode ? "סיום צילום קבלות" : "📷 צילום קבלה"}
          </button>
        </div>
        {pending.length > 0 && (
          <div className="mb-3 rounded-lg bg-[#fdab3d]/15 p-2.5">
            <div className="mb-1.5 flex items-baseline justify-between">
              <b className="text-[12px] text-[#b06c00]">
                📎 {pending.length === 1 ? "קבלה שממתינה לשיוך" : `${pending.length} קבלות שממתינות לשיוך`}
              </b>
              <span className="text-[11px] text-[#b06c00]">
                {attaching ? "עכשיו בחרו הוצאה למטה — כפתור \"צרף כאן\"" : "לחיצה על קבלה ואז על ההוצאה שלה"}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              {pending.map((r) => (
                <span key={r.id} className="flex items-center gap-1.5 rounded-lg bg-[var(--hob-surface)] p-1.5">
                  <button type="button" onClick={() => setViewReceipt(r.id)} title="הגדלה">
                    <img
                      src={`/api/receipt?id=${r.id}`}
                      alt="קבלה ממתינה"
                      className="h-12 w-12 rounded object-cover"
                    />
                  </button>
                  <button
                    type="button"
                    onClick={() => setAttaching(attaching === r.id ? null : r.id)}
                    className={`rounded-md px-2 py-1 text-[11px] font-medium ${
                      attaching === r.id ? "bg-[var(--hob-accent)] text-[var(--hob-accent-fg)]" : "bg-[var(--hob-hover)] text-[var(--hob-soft)]"
                    }`}
                  >
                    {attaching === r.id ? "בחרו הוצאה…" : "שיוך"}
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}
        <div className="mb-3 flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => setPayerFilter("all")}
            className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
              payerFilter === "all" ? "bg-[var(--hob-ink)] text-white" : "bg-[var(--hob-hover)] text-[var(--hob-soft)]"
            }`}
          >
            הכל · {Sh(totalSpent)}
          </button>
          {PAYER_ORDER.filter((p) => p !== "yogev_buyout" || (spentByPayer[p] ?? 0) > 0).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPayerFilter(payerFilter === p ? "all" : p)}
              className="rounded-full px-3 py-1.5 text-xs font-medium transition-colors"
              style={
                payerFilter === p
                  ? { background: PAYER_COLOR[p], color: "#fff" }
                  : { background: PAYER_BG[p], color: PAYER_COLOR[p] }
              }
            >
              {PAYER_LABEL[p]} · {Sh(spentByPayer[p] ?? 0)}
            </button>
          ))}
          <select
            className="mr-auto rounded-full border border-[var(--hob-rule-strong)] bg-[var(--hob-surface)] px-2.5 py-1 text-xs text-[var(--hob-soft)]"
            value={catFilter}
            onChange={(e) => setCatFilter(e.target.value)}
          >
            <option value="all">כל הקטגוריות</option>
            {[...new Set(expenses.map((e) => e.category))].sort().map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
        {(() => {
          const filtered = expenses.filter(
            (e) => (payerFilter === "all" || e.payer === payerFilter) && (catFilter === "all" || e.category === catFilter),
          );
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
          const MONTH_HE = ["ינואר","פברואר","מרץ","אפריל","מאי","יוני","יולי","אוגוסט","ספטמבר","אוקטובר","נובמבר","דצמבר"];
          const label = (key: string) => `${MONTH_HE[parseInt(key.slice(5), 10) - 1] ?? key} ${key.slice(0, 4)}`;
          if (filtered.length === 0)
            return <p className="py-3 text-center text-[12px] text-[var(--hob-faint)]">אין הוצאות שמתאימות לסינון.</p>;
          return months.map((m) => (
            <Fragment key={m.key}>
              <div className="mt-2 flex items-baseline justify-between rounded-md bg-[var(--hob-bg2)] px-2.5 py-1.5 text-[12px] first:mt-0">
                <b className="text-[var(--hob-ink)]">{label(m.key)}</b>
                <span className="text-[var(--hob-soft)]">
                  {m.rows.length} הוצאות · <b className="text-[#e2445c]">{Sh(m.total)}</b>
                </span>
              </div>
              {m.rows.map((e) => (
          <div
            key={e.id}
            // Wraps into two lines on a phone (description underneath), stays
            // one row from sm up — 375px could not hold category AND
            // description without cutting the category to "א..".
            className="group flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-[var(--hob-hover)] py-2 pr-2 text-sm last:border-0"
            style={{ borderRight: `3px solid ${PAYER_COLOR[e.payer] ?? "#d0d4e4"}` }}
          >
            {/* The month is already in the header above, so a phone gets the
                day and month only — the 32px it saves is what keeps the row
                inside the screen. */}
            <span className="w-11 shrink-0 text-xs text-[var(--hob-faint)] sm:w-20" dir="ltr">
              <span className="sm:hidden">{e.date.slice(8) + "/" + e.date.slice(5, 7)}</span>
              <span className="hidden sm:inline">{e.date.split("-").reverse().join("/")}</span>
            </span>
            <span
              className="shrink-0 rounded-full px-2 py-0.5 text-xs font-medium"
              style={{ background: PAYER_BG[e.payer] ?? "#eceff8", color: PAYER_COLOR[e.payer] ?? "#676879" }}
            >
              {PAYER_LABEL[e.payer] ?? e.payer}
            </span>
            {/* Category and description both give up width on a narrow phone —
                if they refuse to shrink the row overflows and every amount
                lands somewhere else. */}
            <span className="min-w-0 shrink truncate font-medium text-[var(--hob-ink)]">{e.category}</span>
            {e.payer === "business" && (
              <PotCell
                value={e.paid_from ?? ""}
                onPick={(paidFrom) => mutate.mutate({ op: "set_expense_paid_from", id: e.id, paidFrom })}
              />
            )}
            {/* Zero-height full-width spacer = a deterministic line break on a
                phone. Without it the row broke wherever it happened to run
                out of width, so the money sat on line 1 in some rows and on
                line 2 in others. */}
            <span className="h-0 w-full sm:hidden" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--hob-soft)] sm:text-sm">{e.description}</span>
            {/* Money, clip and ✕ travel together: separately they wrapped one
                at a time and the ₪ column went crooked again. ms-auto parks
                the group at the end of the phone's first line; on a desktop
                the description already absorbs the slack. */}
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
                className="shrink-0 rounded-md bg-[var(--hob-accent)] px-2 py-0.5 text-[11px] font-medium text-white"
              >
                צרף כאן
              </button>
            ) : (
              <ReceiptCell
                expenseId={e.id}
                receipts={receiptsByExpense.get(e.id) ?? []}
                onView={setViewReceipt}
                onChanged={() => qc.invalidateQueries({ queryKey: ["finance"] })}
                camera={cameraMode}
              />
            )}
            <button
              type="button"
              onClick={() => {
                if (confirmDelete === e.id) {
                  mutate.mutate({ op: "delete_expense", id: e.id });
                  setConfirmDelete(null);
                } else setConfirmDelete(e.id);
              }}
              className={`shrink-0 rounded px-1.5 text-xs ${
                confirmDelete === e.id ? "bg-[#e2445c] text-white" : "text-[var(--hob-faint)] hover:text-[#e2445c]"
              }`}
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

      {/* Budgets */}
      <div className="mb-4 rounded-xl bg-[var(--hob-surface)] p-4 shadow-sm">
        <h3 className="mb-1 text-base font-bold text-[var(--hob-ink)]">📊 תקציב מול ביצוע</h3>
        <p className="mb-2 text-xs text-[var(--hob-faint)]">
          🟢 מתחת ל-70% · 🟡 70-90% · 🔴 מעל 90% — עוצרים ובודקים לפני הוצאה נוספת. לחיצה על סכום התקציב עורכת אותו.
        </p>
        {(data?.budgets ?? []).map((b) => (
          <BudgetRow
            key={b.category}
            budget={b}
            spent={spentByCat.get(b.category) ?? 0}
            onSetBudget={(category, amount) => mutate.mutate({ op: "set_budget", category, amount })}
          />
        ))}
      </div>

      {/* Simulator */}
      <Simulator
        scenarios={data?.scenarios ?? []}
        onSave={(name, scenarioData) => mutate.mutate({ op: "save_scenario", name, data: scenarioData })}
        onDelete={(name) => mutate.mutate({ op: "delete_scenario", name })}
      />

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

