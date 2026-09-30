// 💰 Finance tab: shared expense log, live budget-vs-actual with traffic
// lights, and an interactive profit simulator — the web version of the
// partners' SEGULA-כספים.xlsx workbook.
import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isDemo } from "../demo";
import { parseMoney } from "../board";

import { NIS, Revenue, Scenario, Sh, todayISO } from "./shared";
// The model itself lives in lib/dropmath.ts (shared with the studio tab and
// the public concept page) — this file is the UI around it.
import { FIXED_KEYS, computeSim, normalizeCosts, type DropSim, type SimProduct } from "../../../lib/dropmath";

// Plain-Hebrew explainers behind the (?) button on each P&L row — written
// for a partner who never opened a finance book.
const EXPLAIN: Record<string, string> = {
  "Revenue — סך הכל הכנסה":
    "כל הכסף שנכנס לקופה: מספר היחידות שנמכרו כפול המחיר. זה עוד לא רווח — מכאן מתחילים להוריד את כל העלויות.",
  'הכנסה נטו ממע"מ (÷1.18)':
    'המע"מ שגביתם מהלקוח לא שלכם — הוא עובר למדינה. מחלקים ב-1.18 ומקבלים כמה מהמכירה באמת נשאר אצלכם לעבוד איתו.',
  "COGS — עלות ייצור הנמכרים":
    "Cost of Goods Sold — כמה עלה לייצר רק את מה שנמכר. חולצה שעלתה 48 ₪ ונמכרה — נספרת כאן; חולצה שנשארה במלאי — לא (היא כסף שתקוע במלאי, לא עלות של המכירה).",
  "COGS אחרי שילוח":
    "אותה עלות ייצור + המשלוחים ללקוחות. ככה רואים כמה עולה בפועל 'לספק' את כל ההזמנות, לא רק לייצר אותן.",
  "Gross Profit — רווח גולמי":
    "ההכנסה פחות עלות הייצור. האחוז שלו (Gross Margin) הוא המספר שמשווים בין מותגים — מותג סטריטוור בריא רץ על 55-70%. אם אתם מתחת — המחיר נמוך מדי או הייצור יקר מדי.",
  "Contribution Margin — רווח תרומה":
    "מה שנשאר אחרי כל העלויות שגדלות עם כל מכירה: ייצור ומשלוח. זה המספר הכי חשוב להחלטות — כל יחידה נוספת שנמכרת מוסיפה בדיוק את זה, ומזה מכסים את ההוצאות הקבועות.",
  "שיווק ממומן":
    "תקציב הקמפיינים של הדרופ. הוצאה קבועה — משלמים אותה בין אם המודעה מכרה 10 חולצות או 300.",
  "הוצאות קבועות של הדרופ":
    "צילומים, סמפלים, אריזה, עיצוב — משלמים פעם אחת לדרופ, לא משנה כמה נמכר. ככל שמוכרים יותר, הן 'מתחלקות' על יותר יחידות — ולכן דרופ שמוכר טוב פתאום רווחי בהרבה.",
  "Net Profit — רווח נקי":
    "השורה התחתונה החשבונאית — ההכנסה פחות עלות מה שנמכר, משלוחים, שיווק וקבועות. Net Margin = כמה אגורות מכל שקל מכירה נשארות רווח; 15-20% נחשב טוב למותג צעיר.",
  "Unsold Inventory — מלאי שלא נמכר":
    "שילמתם על כל הייצור מראש. כל פריט שלא נמכר הוא כסף שכבר יצא מהחשבון וטרם חזר — הוא לא 'הפסד' (אפשר למכור אותו בדרופ הבא או במבצע), אבל הוא גם לא בכיס. לכן הוא יורד מהרווח החשבונאי כדי להגיע למזומן האמיתי.",
  "Cash Left — מה שנשאר בפועל":
    "כמה כסף באמת נשאר בחשבון בסוף הדרופ: ההכנסה פחות Total Landed Cost. זה המספר שקובע כמה מההשקעה חזרה וכמה יש לדרופ הבא. ככל שאחוז המכירה עולה, הוא מתקרב ל-Net Profit.",
  "Total Production Cost":
    "כמה עולה לייצר את כל הריצה — כל היחידות שהזמנתם, לא רק אלה שיימכרו. את הסכום הזה משלמים למפעל מראש, לפני שנכנס שקל אחד.",
  "Total Upfront Cost":
    "הייצור המלא ועוד ההוצאות הקבועות — כמה כסף חייב להיות בכיס כדי בכלל להוציא את הדרופ לדרך. זה מספר תזרים, לא מספר רווח.",
  "Variable Costs":
    "משלוחים ללקוחות. בניגוד לקבועות, הם גדלים עם כל הזמנה — ומשולמים מתוך הכסף שנכנס, לא מראש. עמלות סליקה לא נכללות במודל — מוסיפים אותן בנפרד.",
  "Total Landed Cost":
    "כל מה שהדרופ עולה בסוף הדרך: ייצור מלא + קבועות + משלוחים. ההכנסה פחות המספר הזה היא בדיוק Cash Left.",
  "עלות מלאה ליחידה":
    "Total Landed Cost חלקי מספר היחידות שנמכרו. משווים אותו למחיר הממוצע — אם הוא גבוה ממנו, כל יחידה שנמכרת מפסידה כסף. ככל שמוכרים אחוז גבוה יותר, הוא יורד, כי הקבועות מתחלקות על יותר יחידות.",
  "נקודת איזון":
    "כמה יחידות צריך למכור כדי לכסות את השיווק וההוצאות הקבועות. מעבר למספר הזה, כל יחידה נוספת היא רווח כמעט נקי.",
  "עלות ליחידה":
    "מה שהמפעל לוקח על פריט אחד. המספר הזה קבוע — חולצה עולה אותו דבר בין אם תמכרו 10 או 450. זה מה שאתם מזינים למעלה בשורת המוצר.",
  "עלות ליחידה אחרי הכל":
    "כמה פריט אחד שנמכר באמת עלה: הייצור של כל הריצה של אותו מוצר (כולל מה שלא נמכר), המשלוח שלו, וחלקו היחסי בהוצאות הקבועות של הדרופ. המספר הזה לא קבוע — ככל שמוכרים אחוז נמוך יותר הוא עולה, כי אותן הוצאות מתחלקות על פחות יחידות. משווים אותו למחיר: ההפרש הוא המרווח האמיתי לפריט.",
  "Production Cost":
    "עלות הייצור של כל הריצה של המוצר — כמות × עלות ליחידה. זה הסכום שיצא למפעל, בלי קשר לכמה יימכר בסוף.",
  "עלות יחידה":
    "רק מה שהמפעל לקח, בממוצע על היחידות שנמכרו. המספר הזה קבוע — הוא לא זז כשמוכרים יותר או פחות. זו נקודת ההתחלה, ומכאן מוסיפים שכבות.",
  "עלות יחידה אחרי הוצאות כלליות":
    "הייצור ועוד החלק היחסי בהוצאות הקבועות של הדרופ — צילומים, סמפלים, עיצוב, שיווק. אלה הוצאות שלא שייכות לפריט מסוים, אז מחלקים אותן שווה בין היחידות שנמכרו. כאן המספר כבר מתחיל לזוז: כשמוכרים פחות, אותן הוצאות מתחלקות על פחות יחידות.",
};

// The expanded scenario panel uses short labels; the P&L ladder's explainers are
// keyed by the long ones. Alias rather than duplicate the text.
const EXPLAIN_ALIAS: Record<string, string> = {
  Revenue: "Revenue — סך הכל הכנסה",
  "Gross Profit": "Gross Profit — רווח גולמי",
  "Contribution Margin": "Contribution Margin — רווח תרומה",
  "Net Profit": "Net Profit — רווח נקי",
  "Unsold Inventory": "Unsold Inventory — מלאי שלא נמכר",
  "Fixed Costs": "הוצאות קבועות של הדרופ",
};
const explainFor = (label: string): string | undefined => EXPLAIN[EXPLAIN_ALIAS[label] ?? label];

const DROP3: DropSim = {
  dropName: "דרופ 3 — האדם החולם",
  products: [
    { name: "חולצה", qty: 300, price: 199, cost: 48, sellPct: 0.75 },
    { name: "כובע", qty: 150, price: 149, cost: 40, sellPct: 0.75 },
  ],
  itemsPerOrder: 1.3,
  shipPerOrder: 30,
  marketing: 0,
  fixed: 0,
  // The real drop-3 numbers from the expense journal.
  fixedCosts: {
    "שיווק ממומן": 3000,
    "צילומים והפקה": 3500,
    "סמפלים": 4679,
    "אריזה ומיתוג": 800,
    "עיצוב": 600,
    "משפיענים/סידינג": 1000,
    "פופ-אפ/אירועים": 0,
    "אתר ותוכנות": 600,
    'בלת"מ (אחר)': 0,
  },
};
const EMPTY_DROP: DropSim = {
  dropName: "דרופ חדש",
  products: [{ name: "מוצר 1", qty: 100, price: 149, cost: 40, sellPct: 0.75 }],
  itemsPerOrder: 1.2,
  shipPerOrder: 30,
  marketing: 0,
  fixed: 0,
  fixedCosts: {
    "שיווק ממומן": 2000,
    "צילומים והפקה": 2000,
    "סמפלים": 1000,
    "אריזה ומיתוג": 0,
    "עיצוב": 0,
    "משפיענים/סידינג": 0,
    "פופ-אפ/אירועים": 0,
    "אתר ותוכנות": 0,
    'בלת"מ (אחר)': 0,
  },
};
const SIM_KEY = "hob_drop_sim";
const SIM_SAVES_KEY = "hob_drop_sim_saves";

function loadSim(): DropSim {
  try {
    const raw = localStorage.getItem(SIM_KEY);
    if (raw) return JSON.parse(raw) as DropSim;
  } catch {
    // fall through to default
  }
  return DROP3;
}

function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  fmt,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  fmt: (v: number) => ReactNode;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block py-1.5">
      <div className="mb-0.5 flex justify-between text-[13px]">
        <span className="text-[var(--hob-soft)]">{label}</span>
        <span className="font-bold text-[var(--hob-ink)]">{fmt(value)}</span>
      </div>
      <input
        type="range"
        dir="ltr"
        className="w-full accent-[#037f4c]"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
    </label>
  );
}

function NumBox({ value, onChange, width = "w-20", money = false }: { value: number; onChange: (n: number) => void; width?: string; money?: boolean }) {
  return (
    <input
      dir="ltr"
      inputMode="decimal"
      className={`${width} ${money ? "dm " : ""}rounded border border-[var(--hob-rule-strong)] px-1.5 py-1 text-right text-sm focus:border-[#037f4c] focus:outline-none`}
      value={value}
      onChange={(e) => {
        const n = parseFloat(e.target.value);
        if (isFinite(n)) onChange(n);
        else if (e.target.value === "") onChange(0);
      }}
    />
  );
}

export function Simulator({
  scenarios,
  onSave,
  onDelete,
}: {
  scenarios: Scenario[];
  onSave: (name: string, data: string) => void;
  onDelete: (name: string) => void;
}) {
  const [sim, setSimRaw] = useState<DropSim>(loadSim);
  const [openTerm, setOpenTerm] = useState<string | null>(null);
  const [step1Open, setStep1Open] = useState(true);
  const [step2Open, setStep2Open] = useState(true);
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  // Per-row sell-through override for the what-if sandbox. Memory only —
  // nothing here is ever written back to the saved scenario.
  const [whatIf, setWhatIf] = useState<Record<string, number>>({});
  const setSim = (next: DropSim) => {
    setSimRaw(next);
    try {
      localStorage.setItem(SIM_KEY, JSON.stringify(next));
    } catch {
      // storage full/blocked — simulator still works, just not persisted
    }
  };
  const patch = (p: Partial<DropSim>) => setSim({ ...sim, ...p });
  const patchProduct = (i: number, p: Partial<SimProduct>) => {
    const products = sim.products.map((prod, idx) => (idx === i ? { ...prod, ...p } : prod));
    setSim({ ...sim, products });
  };

  const saveScenario = () => onSave(sim.dropName.trim() || "תרחיש", JSON.stringify(sim));

  // One-time lift of scenarios saved back when they lived in localStorage, so
  // nothing a partner already built vanishes the day this ships. The key is
  // removed after the push, so this runs at most once per device.
  useEffect(() => {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(SIM_SAVES_KEY);
    } catch {
      return;
    }
    if (!raw) return;
    try {
      for (const [name, s] of Object.entries(JSON.parse(raw) as Record<string, DropSim>)) {
        onSave(name, JSON.stringify(s));
      }
    } catch {
      // unreadable blob — drop it rather than retry forever
    }
    try {
      localStorage.removeItem(SIM_SAVES_KEY);
    } catch {
      // ignore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const R = computeSim(sim);
  const {
    costs, vatDiv, fixedSum, marketingCost, otherFixed, perProduct, gross, net, production,
    totalUnits, orders, shipping, fees, grossProfit, cogsAfterShipping, contribution, profit,
    productionAll, qtyAll, leftValue, leftUnits, upfront, variable, landed, costPerUnitSold,
    upfrontPerUnitMade, cashProfit, avgContrib, avgPrice, breakEvenUnits,
  } = R;
  const setCost = (key: string, n: number) =>
    setSim({ ...sim, marketing: 0, fixed: 0, fixedItems: undefined, fixedCosts: { ...costs, [key]: n } });
  const pctOfNet = (v: number) => (net > 0 ? `${Math.round((v / net) * 100)}%` : "—");
  const fixedTotal = fixedSum;
  const breakEvenRevenue = breakEvenUnits !== null ? breakEvenUnits * avgPrice : null;
  const toReturn = Math.max(0, Math.min(1, cashProfit / 60000));

  // Fully-sold scenario — the reference point for "what is sell-through worth".
  const allSold = computeSim({ ...sim, products: sim.products.map((p) => ({ ...p, sellPct: 1 })) });

  // ---- "מה כדאי לעשות": every lever re-runs the whole model, so the numbers
  // stay honest no matter what the partners changed above. ----
  const bump = (add: number) =>
    computeSim({ ...sim, products: sim.products.map((p) => ({ ...p, sellPct: Math.min(1, p.sellPct + add) })) });
  const plus15 = bump(0.15);
  const biggest = perProduct.reduce((a, b) => (b.gross > a.gross ? b : a), perProduct[0]);
  const pricedUp = computeSim({
    ...sim,
    products: sim.products.map((p) => (p.name === biggest?.name ? { ...p, price: p.price + 20 } : p)),
  });
  // Clearing leftovers at half price: no new production cost, just ship + fees.
  const clearance = leftUnits > 0 ? leftUnits * (avgPrice * 0.5 - R.shipPerUnit) : 0;

  const actions = [
    {
      title: `למכור את כל המלאי (${Math.round((totalUnits / Math.max(qtyAll, 1)) * 100)}% → 100%)`,
      gain: allSold.cashProfit - cashProfit,
      note: `העלות המלאה ליחידה יורדת מ-${NIS(costPerUnitSold)} ל-${NIS(allSold.costPerUnitSold)} — ההוצאות הקבועות מתחלקות על ${qtyAll} יח' במקום ${totalUnits}.`,
    },
    {
      title: "להעלות את אחוז המכירה ב-15 נקודות",
      gain: plus15.cashProfit - cashProfit,
      note: `${plus15.totalUnits - totalUnits} יחידות נוספות. כל יחידה מעבר לאיזון מוסיפה ${NIS(avgContrib)} נקי.`,
    },
    {
      title: `מבצע סוף עונה על ${leftUnits} היחידות שנשארות`,
      gain: clearance,
      note: `במחצית המחיר. כבר שילמת עליהן ${NIS(leftValue)} — אין עלות ייצור נוספת, רק משלוח.`,
    },
    {
      title: `${biggest?.name ?? "המוצר המוביל"}: ${NIS(biggest?.price ?? 0)} → ${NIS((biggest?.price ?? 0) + 20)}`,
      gain: pricedUp.cashProfit - cashProfit,
      note: "בהנחה שאחוז המכירה לא נפגע — הנחה שצריך לבדוק לפני שמעלים מחיר.",
    },
  ]
    .filter((a) => isFinite(a.gain) && a.gain > 0)
    .sort((a, b) => b.gain - a.gain);

  // ---- Saved-scenario rows. The open scenario leads, so you always compare
  // what you are editing against what you already decided. ----
  const rows = useMemo(() => {
    type Row = { key: string; name: string; sim: DropSim; r: ReturnType<typeof computeSim>; live: boolean };
    const all: Row[] = [{ key: "live", name: sim.dropName || "תרחיש נוכחי", sim, r: R, live: true }];
    for (const s of scenarios) {
      // A single bad row must not take the whole tab down with it.
      try {
        const parsed = JSON.parse(s.data) as DropSim;
        if (!parsed || !Array.isArray(parsed.products) || parsed.products.length === 0) continue;
        all.push({ key: `saved:${s.name}`, name: s.name, sim: parsed, r: computeSim(parsed), live: false });
      } catch {
        continue;
      }
    }
    const top = Math.max(...all.map((x) => x.r.cashProfit));
    return all.map((x) => ({ ...x, best: all.length > 1 && x.r.cashProfit === top }));
  }, [scenarios, sim, R]);

  const exportCsv = () => {
    const cols: [string, (x: (typeof rows)[number]) => string | number][] = [
      ["תרחיש", (x) => x.name],
      ["יחידות מיוצרות", (x) => x.r.qtyAll],
      ["יחידות שנמכרות", (x) => x.r.totalUnits],
      ["% מכירה", (x) => (x.r.qtyAll > 0 ? Math.round((x.r.totalUnits / x.r.qtyAll) * 100) : 0)],
      ["מחיר ממוצע", (x) => Math.round(x.r.avgPrice)],
      ["Total Production Cost", (x) => Math.round(x.r.productionAll)],
      ["Fixed Costs", (x) => Math.round(x.r.fixedSum)],
      ["Total Upfront Cost", (x) => Math.round(x.r.upfront)],
      ["Variable Costs", (x) => Math.round(x.r.variable)],
      ["Total Landed Cost", (x) => Math.round(x.r.landed)],
      ["Revenue", (x) => Math.round(x.r.gross)],
      ["Gross Profit", (x) => Math.round(x.r.grossProfit)],
      ["Contribution Margin", (x) => Math.round(x.r.contribution)],
      ["Net Profit", (x) => Math.round(x.r.profit)],
      ["Unsold Inventory", (x) => -Math.round(x.r.leftValue)],
      ["Cash Left", (x) => Math.round(x.r.cashProfit)],
      ["Gross Margin %", (x) => (x.r.net > 0 ? Math.round((x.r.grossProfit / x.r.net) * 100) : 0)],
      ["Net Margin %", (x) => (x.r.net > 0 ? Math.round((x.r.profit / x.r.net) * 100) : 0)],
      ["עלות מלאה ליחידה", (x) => Math.round(x.r.costPerUnitSold)],
      ["נקודת איזון", (x) => x.r.breakEvenUnits ?? 0],
    ];
    const esc = (v: string | number) => {
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    // Metrics as rows, scenarios as columns — reads like the on-screen table.
    const lines = cols.map(([label, get]) => [label, ...rows.map(get)].map(esc).join(","));
    // The BOM is not optional: without it Excel decodes the file as Latin-1
    // and every Hebrew label turns to mojibake.
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `segula-drops-${todayISO()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="hob-nodemo rounded-xl bg-[var(--hob-surface)] p-4 shadow-sm">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-bold text-[var(--hob-ink)]">🎛 סימולטור דרופ — לכל דרופ שתרצו</h3>
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => patch({ vatExempt: sim.vatExempt === false })}
            className="rounded-full px-3 py-1 text-xs font-medium"
            style={
              sim.vatExempt === false
                ? { background: "#fdab3d", color: "#fff" }
                : { background: "#e6f6ee", color: "#00854d" }
            }
            title="לחיצה מחליפה בין עוסק פטור (בלי מע&quot;מ) לעוסק מורשה (מע&quot;מ 18%)"
          >
            {sim.vatExempt === false ? '🧾 עוסק מורשה — מע"מ 18%' : '🧾 עוסק פטור — בלי מע"מ'}
          </button>
          <button type="button" onClick={() => setSim(DROP3)} className="rounded-full bg-[var(--hob-hover)] px-3 py-1 text-xs text-[var(--hob-soft)] hover:bg-[#0073ea]/20">
            דרופ 3 (הנוכחי)
          </button>
          <button type="button" onClick={() => setSim(EMPTY_DROP)} className="rounded-full bg-[var(--hob-hover)] px-3 py-1 text-xs text-[var(--hob-soft)] hover:bg-[#0073ea]/20">
            ➕ דרופ חדש
          </button>
        </div>
      </div>

      {/* Drop name + saved scenarios */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          className="rounded-md border border-[var(--hob-rule-strong)] px-3 py-1.5 text-sm font-bold focus:border-[#037f4c] focus:outline-none"
          value={sim.dropName}
          onChange={(e) => patch({ dropName: e.target.value })}
        />
        <button type="button" onClick={saveScenario} className="rounded-md bg-[#037f4c] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#026b40]">
          💾 שמירת תרחיש
        </button>
        <span className="text-[11px] text-[var(--hob-faint)]">
          נשמר בטבלה למטה — שניכם רואים את אותם תרחישים
        </span>
      </div>

      {/* Step 1: products */}
      <div className="mb-3 rounded-lg border border-[var(--hob-hover)] p-3">
        <button type="button" onClick={() => setStep1Open(!step1Open)} className="flex w-full items-center gap-2 text-right">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#037f4c] text-xs font-bold text-white">1</span>
          <span className="text-sm font-bold text-[var(--hob-ink)]">המוצרים של הדרופ</span>
          <span className="mr-auto flex items-center gap-2 text-xs text-[var(--hob-faint)]">
            {!step1Open && <span>{sim.products.length} מוצרים · מחזור {Sh(gross)}</span>}
            <span>{step1Open ? "▲" : "▼"}</span>
          </span>
        </button>
        {step1Open && (
        <div className="mt-2">
        <div className="mb-1 grid grid-cols-[1fr_64px_72px_72px] items-center gap-2 text-[11px] text-[var(--hob-faint)] sm:grid-cols-[1fr_70px_80px_80px_1fr]">
          <span>מוצר</span><span>כמות</span><span>מחיר ₪</span><span>עלות ₪</span><span className="hidden sm:block">כמה % יימכר</span>
        </div>
        {sim.products.map((p, i) => (
          <div key={i} className="mb-2 grid grid-cols-[1fr_64px_72px_72px] items-center gap-2 sm:grid-cols-[1fr_70px_80px_80px_1fr]">
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setSim({ ...sim, products: sim.products.filter((_, idx) => idx !== i) })}
                disabled={sim.products.length <= 1}
                className="text-xs text-[var(--hob-faint)] hover:text-[#e2445c] disabled:opacity-30"
              >
                ✕
              </button>
              <input
                className="w-full min-w-0 rounded border border-[var(--hob-rule-strong)] px-1.5 py-1 text-sm focus:border-[#037f4c] focus:outline-none"
                value={p.name}
                onChange={(e) => patchProduct(i, { name: e.target.value })}
              />
            </div>
            <NumBox value={p.qty} onChange={(n) => patchProduct(i, { qty: Math.max(0, Math.round(n)) })} width="w-full" />
            <NumBox money value={p.price} onChange={(n) => patchProduct(i, { price: Math.max(0, n) })} width="w-full" />
            <NumBox money value={p.cost} onChange={(n) => patchProduct(i, { cost: Math.max(0, n) })} width="w-full" />
            <div className="col-span-4 sm:col-span-1">
              <input
                type="range"
                dir="ltr"
                className="w-full accent-[#037f4c]"
                min={0}
                max={1}
                step={0.05}
                value={p.sellPct}
                onChange={(e) => patchProduct(i, { sellPct: parseFloat(e.target.value) })}
              />
              <div className="text-center text-[11px] text-[var(--hob-soft)]">
                {Math.round(p.sellPct * 100)}% = {Math.round(p.qty * p.sellPct)} יח' · תרומה {Sh(p.price / vatDiv - p.cost)}/יח'
              </div>
            </div>
          </div>
        ))}
        <button
          type="button"
          onClick={() => setSim({ ...sim, products: [...sim.products, { name: `מוצר ${sim.products.length + 1}`, qty: 100, price: 99, cost: 30, sellPct: 0.75 }] })}
          className="rounded-md bg-[var(--hob-hover)] px-3 py-1 text-xs text-[var(--hob-soft)] hover:bg-[#0073ea]/20"
        >
          ➕ הוספת מוצר
        </button>
        </div>
        )}
      </div>

      {/* Step 2: drop costs */}
      <div className="mb-3 rounded-lg border border-[var(--hob-hover)] p-3">
        <button type="button" onClick={() => setStep2Open(!step2Open)} className="flex w-full items-center gap-2 text-right">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#037f4c] text-xs font-bold text-white">2</span>
          <span className="text-sm font-bold text-[var(--hob-ink)]">ההוצאות של הדרופ</span>
          <span className="mr-auto flex items-center gap-2 text-xs text-[var(--hob-faint)]">
            {!step2Open && <span>סה"כ {Sh(fixedSum)}</span>}
            <span>{step2Open ? "▲" : "▼"}</span>
          </span>
        </button>
        {step2Open && (
        <div className="mt-2">
        <div className="grid gap-x-6 sm:grid-cols-2">
          <Slider label="משלוח ממוצע להזמנה" value={sim.shipPerOrder} min={0} max={45} fmt={Sh} onChange={(v) => patch({ shipPerOrder: v })} />
          <Slider label="פריטים בממוצע בהזמנה" value={sim.itemsPerOrder} min={1} max={2.5} step={0.1} fmt={(v) => v.toFixed(1)} onChange={(v) => patch({ itemsPerOrder: v })} />
        </div>
        <div className="mt-2 rounded-md bg-[var(--hob-bg2)] p-2.5">
          <div className="mb-1.5 flex items-baseline justify-between">
            <span className="text-[13px] font-bold text-[var(--hob-ink)]">עלויות הדרופ — בפירוט</span>
            <span className="text-[13px] font-bold text-[#e2445c]">{Sh(fixedSum)}</span>
          </div>
          <div className="grid gap-x-6 sm:grid-cols-2">
            {FIXED_KEYS.map((key) => (
              <div key={key} className="flex items-center justify-between gap-2 py-1">
                <span className="text-[13px] text-[var(--hob-soft)]">{key}</span>
                <NumBox money value={costs[key]} onChange={(n) => setCost(key, Math.max(0, n))} width="w-24" />
              </div>
            ))}
          </div>
          <p className="mt-1.5 text-[10.5px] text-[var(--hob-faint)]">
            הוצאות חד-פעמיות שלא תלויות בכמות שנמכרת. הייצור עצמו כבר בעלות ליחידה למעלה; משלוח ללקוח — בסליידר. עמלות סליקה לא במודל.
          </p>
        </div>
        </div>
        )}
      </div>

      {/* Step 3: result */}
      <div className="rounded-lg border border-[var(--hob-hover)] p-3">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#037f4c] text-xs font-bold text-white">3</span>
          <span className="text-sm font-bold text-[var(--hob-ink)]">התוצאה — {sim.dropName}</span>
        </div>

        {/* Total Drop Cost — what has to be on the table before a single sale */}
        <div className="mb-3 rounded-lg border border-[var(--hob-hover)] bg-[var(--hob-bg2)] p-3">
          <div className="mb-0.5 text-[13px] font-bold text-[var(--hob-ink)]">💰 Total Drop Cost — כמה הדרופ עולה</div>
          <div className="mb-2 text-[10.5px] text-[var(--hob-faint)]">כמה כסף צריך לשים על השולחן לפני שנכנס שקל אחד ממכירות.</div>
          {sim.products.map((p, i) => (
            <div key={i} className="flex py-1 text-[12px] text-[var(--hob-soft)]">
              <span className="pr-3">
                {p.name} · {p.qty} יח' × {Sh(p.cost)}
              </span>
              <span className="mr-auto tabular-nums">{Sh(p.qty * p.cost)}</span>
            </div>
          ))}
          <div className="flex border-t border-[#e6e9f0] py-1.5 text-[12.5px]">
            <span className="font-bold text-[var(--hob-ink)]">Total Production Cost</span>
            <span className="mr-1.5 self-center text-[10.5px] text-[var(--hob-faint)]">{qtyAll} יח' · עלות ייצור כוללת</span>
            <span className="mr-auto font-bold tabular-nums">{Sh(productionAll)}</span>
          </div>
          <div className="flex border-t border-[#e6e9f0] py-1.5 text-[12.5px]">
            <span className="font-bold text-[var(--hob-ink)]">+ Fixed Costs</span>
            <span className="mr-1.5 self-center text-[10.5px] text-[var(--hob-faint)]">
              {FIXED_KEYS.filter((k) => costs[k] > 0).join(" · ") || "אין"}
            </span>
            <span className="mr-auto font-bold tabular-nums">{Sh(fixedSum)}</span>
          </div>
          <div className="my-2 flex items-center rounded-lg border border-[#0073ea]/30 bg-[#0073ea]/15 p-2.5">
            <div>
              <div className="text-[13px] font-extrabold text-[var(--hob-ink)]">= Total Upfront Cost</div>
              <div className="text-[10.5px] text-[var(--hob-soft)]">
                כמה צריך בכיס לפני מכירות · {Sh(upfrontPerUnitMade)} ליחידה מיוצרת
              </div>
            </div>
            <span className="mr-auto text-lg font-extrabold tabular-nums text-[var(--hob-accent)]">{Sh(upfront)}</span>
          </div>
          <div className="flex border-t border-[#e6e9f0] py-1.5 text-[12.5px] text-[var(--hob-soft)]">
            <span>+ Variable Costs</span>
            <span className="mr-1.5 self-center text-[10.5px] text-[var(--hob-faint)]">
              משלוחים ללקוחות · משולם מהמכירות
            </span>
            <span className="mr-auto tabular-nums">{Sh(variable)}</span>
          </div>
          <div className="flex items-center border-t border-[#e6e9f0] pt-2 text-[13px]">
            <div>
              <span className="font-extrabold text-[var(--hob-ink)]">= Total Landed Cost</span>
              <div className="text-[10.5px] text-[var(--hob-soft)]">עלות כוללת אחרי כל ההוצאות</div>
            </div>
            <span className="mr-auto text-base font-extrabold tabular-nums text-[var(--hob-ink)]">{Sh(landed)}</span>
          </div>
          <div className="mt-2 rounded-md bg-[var(--hob-surface)] p-2 text-[11.5px] leading-relaxed">
            <b>Full Cost per Unit Sold — עלות מלאה ליחידה: {Sh(costPerUnitSold)}</b>
            <span className="text-[var(--hob-soft)]"> · מחיר ממוצע {Sh(avgPrice)}</span>
            {leftUnits > 0 && (
              <div className="mt-0.5 text-[var(--hob-soft)]">
                אם תמכרו <b>100%</b> מהמלאי, אותה עלות יורדת ל-
                <b className="text-[var(--hob-good)]">{Sh(allSold.costPerUnitSold)}</b> ליחידה — ההוצאות הקבועות
                מתחלקות על {qtyAll} יח' במקום {totalUnits}. זו הסיבה שאחוז המכירה הוא המנוף החזק ביותר.
              </div>
            )}
          </div>
        </div>

        <div className="mb-2 overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="text-[var(--hob-faint)]">
                <th className="pb-1 text-right font-normal">מוצר</th>
                <th className="pb-1 text-right font-normal">יימכרו</th>
                {(["עלות ליחידה", "עלות ליחידה אחרי הכל", "Production Cost"] as const).map((h) => (
                  <th key={h} className="whitespace-nowrap pb-1 text-right font-normal">
                    <span className={h === "עלות ליחידה אחרי הכל" ? "text-[#d0453e]" : h === "Production Cost" ? "text-[var(--hob-accent)]" : ""}>
                      {h}
                    </span>
                    <button
                      type="button"
                      onClick={() => setOpenTerm(openTerm === h ? null : h)}
                      className="mr-1 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[var(--hob-hover)] text-[9px] font-bold text-[var(--hob-faint)] hover:bg-[#0073ea]/20"
                      title="מה זה אומר?"
                    >
                      ?
                    </button>
                  </th>
                ))}
                <th className="pb-1 text-right font-normal">Revenue</th>
                <th className="pb-1 text-right font-normal">Contribution</th>
                <th className="pb-1 text-right font-normal">תקוע במלאי</th>
              </tr>
            </thead>
            <tbody>
              {perProduct.map((p, i) => (
                <tr key={i} className="border-t border-[var(--hob-hover)]">
                  <td className="py-1 font-medium">{p.name}</td>
                  <td className="py-1">{p.units} / {p.qty}</td>
                  <td className="py-1">{Sh(p.cost)}</td>
                  <td className="py-1 font-bold" style={{ color: p.fullCostPerUnit > p.price ? "#e2445c" : "#d0453e" }}>
                    {Sh(p.fullCostPerUnit)}
                    <span className="block text-[10px] font-normal text-[var(--hob-faint)]">
                      מרווח {Sh(p.price - p.fullCostPerUnit)}
                    </span>
                  </td>
                  <td className="py-1 font-medium text-[var(--hob-accent)]">{Sh(p.productionAll)}</td>
                  <td className="py-1">{Sh(p.gross)}</td>
                  <td className="py-1 font-bold text-[var(--hob-good)]">{Sh(p.contribution)}</td>
                  <td className="py-1 text-[var(--hob-faint)]">
                    {p.leftUnits > 0 ? (
                      <>
                        {Sh(p.leftValue)}
                        <span className="text-[10.5px]"> · {p.leftUnits} יח'</span>
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {openTerm && explainFor(openTerm) && ["עלות ליחידה", "עלות ליחידה אחרי הכל", "Production Cost"].includes(openTerm) && (
            <div className="mt-1 rounded-md bg-[var(--hob-bg2)] px-2.5 py-2 text-[11.5px] leading-relaxed text-[var(--hob-ink)]">
              <b>{openTerm}</b> — {explainFor(openTerm)}
            </div>
          )}
        </div>
        {/* P&L ladder — same terms and colors as the partners' Google Sheet */}
        <div className="overflow-x-auto rounded-lg border border-[var(--hob-hover)]">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="bg-[var(--hob-bg2)] text-[11px] text-[var(--hob-soft)]">
                <th className="px-2 py-1.5 text-right font-normal">מושג</th>
                <th className="px-2 py-1.5 text-right font-normal">סכום</th>
                <th className="px-2 py-1.5 text-right font-normal">% מההכנסה נטו</th>
              </tr>
            </thead>
            <tbody>
              {([
                ["Revenue — סך הכל הכנסה", `${totalUnits} יחידות`, gross, "rgba(0,200,117,.22)", true, sim.vatExempt === false ? "" : "100%"],
                ...(sim.vatExempt === false
                  ? [["הכנסה נטו ממע\"מ (÷1.18)", "הבסיס לכל האחוזים", net, "rgba(0,200,117,.10)", false, "100%"] as [string, string, number, string, boolean, string]]
                  : []),
                ["COGS — עלות ייצור הנמכרים", "רק מה שנמכר, לא כל הייצור", -production, "rgba(226,68,92,.10)", false, pctOfNet(production)],
                ["COGS אחרי שילוח", `ייצור + משלוחים (${Math.round(orders)} הזמנות)`, -cogsAfterShipping, "rgba(226,68,92,.20)", false, pctOfNet(cogsAfterShipping)],
                ["Gross Profit — רווח גולמי", "נטו פחות COGS · Gross Margin", grossProfit, "rgba(0,200,117,.10)", true, pctOfNet(grossProfit)],
                ["Contribution Margin — רווח תרומה", "אחרי גם המשלוחים — כל שקל מכירה נוסף מוסיף לפי זה", contribution, "rgba(0,200,117,.10)", true, pctOfNet(contribution)],
                ["שיווק ממומן", "הקמפיינים של הדרופ", -marketingCost, "rgba(226,68,92,.10)", false, pctOfNet(marketingCost)],
                ["הוצאות קבועות של הדרופ", FIXED_KEYS.filter((k) => k !== "שיווק ממומן" && costs[k] > 0).join(" · ") || "אין", -otherFixed, "rgba(226,68,92,.10)", false, pctOfNet(otherFixed)],
                ["Net Profit — רווח נקי", "התוצאה החשבונאית", profit, "rgba(0,200,117,.10)", true, pctOfNet(profit)],
                ...(leftUnits > 0
                  ? [[
                      "Unsold Inventory — מלאי שלא נמכר",
                      `${leftUnits} יח' ששולם עליהן ולא חזרו`,
                      -leftValue,
                      "rgba(226,68,92,.20)",
                      false,
                      pctOfNet(leftValue),
                    ] as [string, string, number, string, boolean, string]]
                  : []),
              ] as [string, string, number, string, boolean, string][]).map(([label, hint, value, bg, bold, pct]) => (
                <tr key={label} style={{ background: bg }}>
                  <td className="px-2 py-1.5">
                    <span className={bold ? "font-bold" : "font-medium"}>{label}</span>
                    {EXPLAIN[label] && (
                      <button
                        type="button"
                        onClick={() => setOpenTerm(openTerm === label ? null : label)}
                        className="mr-1.5 inline-flex h-4 w-4 items-center justify-center rounded-full bg-[#00000022] text-[10px] font-bold text-[#00000099] hover:bg-[#00000033]"
                        title="מה זה אומר?"
                      >
                        ?
                      </button>
                    )}
                    {hint && <span className="mr-1 block text-[10.5px] text-[#00000080] sm:mr-0">{hint}</span>}
                    {openTerm === label && EXPLAIN[label] && (
                      <span className="mt-1 block max-w-md rounded-md bg-[var(--hob-surface)] px-2 py-1.5 text-[11.5px] leading-relaxed text-[var(--hob-ink)]">
                        {EXPLAIN[label]}
                      </span>
                    )}
                  </td>
                  <td
                    className={`px-2 py-1.5 ${bold ? "font-bold" : "font-medium"}`}
                    dir="ltr"
                    style={{ textAlign: "right", color: value < 0 ? "#d0453e" : "#1c7a45" }}
                  >
                    <span className="dm">{value < 0 ? `-${NIS(-value)}` : NIS(value)}</span>
                  </td>
                  <td className="px-2 py-1.5 text-[12px]">{pct}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {/* Break-even */}
        <div className="mt-3 rounded-lg border border-[#fdab3d]/30 bg-[#fdab3d]/15 p-3 text-sm">
          <div className="mb-1 font-bold text-[var(--hob-ink)]">🎯 נקודת איזון (Break-Even)</div>
          {breakEvenUnits === null ? (
            <p className="text-[#e2445c]">
              במחירים והעלויות האלה כל יחידה מפסידה כסף — אין נקודת איזון. תעלו מחיר או תורידו עלויות.
            </p>
          ) : (
            <>
              <p className="text-[var(--hob-soft)]">
                כדי לכסות שיווק + קבועות ({Sh(fixedTotal)}) צריך למכור{" "}
                <b className="text-[var(--hob-ink)]">{breakEvenUnits} יחידות</b> לפי התמהיל הנוכחי ≈{" "}
                <b className="text-[var(--hob-ink)]">{Sh(breakEvenRevenue ?? 0)}</b> פדיון.
                {" "}כל יחידה מעבר לזה = <b className="text-[var(--hob-good)]">{Sh(avgContrib)}</b> רווח נקי לכיס.
              </p>
              <div className="mt-2">
                <div className="mb-1 flex justify-between text-[11px] text-[var(--hob-soft)]">
                  <span>בתרחיש הזה נמכרות {totalUnits} יחידות</span>
                  <b style={{ color: totalUnits >= breakEvenUnits ? "#00854d" : "#e2445c" }}>
                    {totalUnits >= breakEvenUnits
                      ? `${totalUnits - breakEvenUnits} יחידות מעל האיזון ✓`
                      : `חסרות ${breakEvenUnits - totalUnits} יחידות לאיזון`}
                  </b>
                </div>
                <div className="relative h-2.5 overflow-hidden rounded-full bg-[var(--hob-hover)]">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{
                      width: `${Math.min(100, (totalUnits / Math.max(breakEvenUnits, totalUnits, 1)) * 100)}%`,
                      background: totalUnits >= breakEvenUnits ? "#00c875" : "#fdab3d",
                    }}
                  />
                  <div
                    className="absolute top-0 h-full w-0.5 bg-[#e2445c]"
                    style={{ right: `${Math.min(100, (breakEvenUnits / Math.max(breakEvenUnits, totalUnits, 1)) * 100)}%` }}
                    title={`נקודת האיזון: ${breakEvenUnits} יחידות`}
                  />
                </div>
              </div>
            </>
          )}
        </div>

        <div
          className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg p-3"
          style={{ background: cashProfit >= 0 ? "rgba(0,200,117,.15)" : "rgba(226,68,92,.15)" }}
        >
          <div>
            <div className="text-xs text-[var(--hob-soft)]">
              Cash Left — מה שנשאר בפועל · {sim.dropName}
              <button
                type="button"
                onClick={() => setOpenTerm(openTerm === "net" ? null : "net")}
                className="mr-1.5 inline-flex h-4 w-4 items-center justify-center rounded-full bg-[#00000022] text-[10px] font-bold text-[#00000099] hover:bg-[#00000033]"
                title="מה זה אומר?"
              >
                ?
              </button>
            </div>
            {openTerm === "net" && (
              <div className="mt-1 max-w-md rounded-md bg-[var(--hob-surface)] px-2 py-1.5 text-[11.5px] leading-relaxed text-[var(--hob-ink)]">
                {EXPLAIN["Cash Left — מה שנשאר בפועל"]}
              </div>
            )}
            <div className="text-2xl font-extrabold" style={{ color: cashProfit >= 0 ? "#00854d" : "#e2445c" }}>
              {Sh(cashProfit)}
            </div>
          </div>
          <div className="text-left text-sm text-[var(--hob-soft)]">
            <div>
              Net Profit: <b>{Sh(profit)}</b> · Net Margin: <b>{pctOfNet(profit)}</b>
            </div>
            <div>
              מהדרך להחזר 60K: <b>{Math.round((cashProfit / 60000) * 100)}%</b>
            </div>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--hob-surface)]">
            <div className="h-full rounded-full bg-[#037f4c] transition-all" style={{ width: `${toReturn * 100}%` }} />
          </div>
        </div>

        {/* What to actually do — every lever re-runs the model, so it tracks
            whatever the partners changed above. */}
        {actions.length > 0 && (
          <div className="mt-3 rounded-lg border border-[var(--hob-hover)] p-3">
            <div className="text-sm font-bold text-[var(--hob-ink)]">🎯 מה כדאי לעשות</div>
            <div className="mb-2 text-[10.5px] text-[var(--hob-faint)]">
              מחושב מהמספרים שלמעלה · מתעדכן עם כל שינוי
            </div>
            <div className="flex flex-col gap-1.5">
              {actions.map((a, i) => (
                <div
                  key={a.title}
                  className="rounded-md border p-2.5"
                  style={
                    i === 0
                      ? { borderColor: "#b7e3cc", background: "#e6f6ee" }
                      : { borderColor: "#eceff8" }
                  }
                >
                  <div className="flex items-baseline gap-2">
                    <span className="text-[12.5px] font-bold text-[var(--hob-ink)]">{a.title}</span>
                    <span className="mr-auto text-sm font-extrabold text-[var(--hob-good)]">+{Sh(a.gain)}</span>
                  </div>
                  <div className="mt-0.5 text-[11px] leading-relaxed text-[var(--hob-soft)] dm-block">{a.note}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
          {/* Sticky live result — visible while scrolling inside the simulator */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-xl bg-[var(--hob-ink)] px-4 py-2.5 text-white">
        <span className="text-sm">
          Cash Left:{" "}
          <b className="text-base" style={{ color: cashProfit >= 0 ? "#5ce29a" : "#ff7b8f" }}>{Sh(cashProfit)}</b>
        </span>
        <span className="text-xs text-[var(--hob-faint)]">
          Upfront: <b className="text-white">{Sh(upfront)}</b>
          {" · "}עלות/יח': <b className="text-white">{Sh(costPerUnitSold)}</b>
          {" · "}איזון: <b className="text-white">{breakEvenUnits ?? "—"} יח'</b>
          {" · "}Gross Margin: <b className="text-white">{pctOfNet(grossProfit)}</b>
          {leftValue > 0 && (
            <>
              {" · "}תקוע במלאי: <b className="text-white">{Sh(leftValue)}</b>
            </>
          )}
        </span>
      </div>

      {/* Saved scenarios — one row each, expandable. A row IS the collapsed
          form, so ten scenarios stay ten lines instead of ten stacked cards. */}
      <div className="mt-3 rounded-lg border border-[var(--hob-hover)]">
        <div className="flex flex-wrap items-baseline gap-2 border-b border-[var(--hob-hover)] p-3">
          <span className="text-sm font-bold text-[var(--hob-ink)]">📋 תרחישים שמורים ({rows.length})</span>
          {rows.length > 0 && (
            <button
              type="button"
              onClick={exportCsv}
              className="mr-auto rounded-full border border-[#00c875]/40 bg-[#00c875]/15 px-3 py-1 text-[11px] font-medium text-[var(--hob-good)] hover:bg-[#00c875]/25"
            >
              ⬇ ייצוא ל-Excel
            </button>
          )}
        </div>
        {rows.length === 0 ? (
          <p className="p-3 text-[12px] text-[var(--hob-faint)]">
            עוד לא שמרתם תרחישים. שנו את המספרים למעלה, תנו שם לדרופ ולחצו 💾 — הוא יופיע כאן כשורה,
            ותוכלו להשוות בין דרופים במקום לזכור מספרים.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px] tabular-nums">
              <thead>
                <tr className="bg-[var(--hob-bg2)] text-[10.5px] text-[var(--hob-soft)]">
                  <th className="px-3 py-1.5 text-right font-normal">תרחיש</th>
                  <th className="px-2 py-1.5 text-right font-normal">יחידות</th>
                  <th className="px-2 py-1.5 text-right font-normal">Upfront</th>
                  <th className="px-2 py-1.5 text-right font-normal">Cash Left</th>
                  <th className="px-2 py-1.5 text-right font-normal">Net Margin</th>
                  <th className="px-2 py-1.5 text-right font-normal">עלות/יח'</th>
                  <th className="px-2 py-1.5 text-right font-normal"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const open = openRow === row.key;
                  return (
                    <Fragment key={row.key}>
                      <tr
                        className="cursor-pointer border-t border-[var(--hob-hover)] hover:bg-[var(--hob-bg2)]"
                        onClick={() => setOpenRow(open ? null : row.key)}
                      >
                        <td className="px-3 py-2">
                          <span className="text-[var(--hob-faint)]">{open ? "▾" : "▸"}</span>{" "}
                          <span className="font-medium text-[var(--hob-ink)]">{row.name}</span>
                          {row.sim.note && (
                            <span className="dm-block mr-1.5 text-[10.5px] text-[var(--hob-faint)]">📝 {row.sim.note}</span>
                          )}
                          {row.live && (
                            <span className="mr-1.5 rounded-full bg-[#0073ea]/15 px-1.5 py-0.5 text-[9.5px] text-[var(--hob-accent)]">
                              פתוח עכשיו
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-2">
                          {row.r.totalUnits} / {row.r.qtyAll}
                        </td>
                        <td className="px-2 py-2">{Sh(row.r.upfront)}</td>
                        <td
                          className="px-2 py-2 font-bold"
                          style={{ color: row.r.cashProfit >= 0 ? "#00854d" : "#e2445c" }}
                        >
                          {Sh(row.r.cashProfit)}
                          {row.best && <span title="הכי גבוה"> 🏆</span>}
                        </td>
                        <td className="px-2 py-2">
                          {row.r.net > 0 ? `${Math.round((row.r.profit / row.r.net) * 100)}%` : "—"}
                        </td>
                        <td className="px-2 py-2">{Sh(row.r.costPerUnitSold)}</td>
                        <td className="px-2 py-2 text-left" onClick={(e) => e.stopPropagation()}>
                          {!row.live && (
                            <>
                              <button
                                type="button"
                                onClick={() => row.sim && setSim(row.sim)}
                                className="rounded px-1.5 text-[11px] text-[var(--hob-accent)] hover:underline"
                              >
                                טען
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  // Find a free name so a copy never overwrites.
                                  const names = new Set(rows.map((x) => x.name));
                                  let copy = `${row.name} (עותק)`;
                                  for (let k = 2; names.has(copy); k++) copy = `${row.name} (עותק ${k})`;
                                  onSave(copy, JSON.stringify({ ...row.sim, dropName: copy }));
                                }}
                                className="rounded px-1.5 text-[11px] text-[var(--hob-soft)] hover:underline"
                                title="יוצר עותק לעריכה בלי לגעת במקור"
                              >
                                שכפל
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  if (confirmDel === row.name) {
                                    onDelete(row.name);
                                    setConfirmDel(null);
                                  } else setConfirmDel(row.name);
                                }}
                                className={`rounded px-1.5 text-[11px] ${
                                  confirmDel === row.name
                                    ? "bg-[#e2445c] text-white"
                                    : "text-[var(--hob-faint)] hover:text-[#e2445c]"
                                }`}
                              >
                                {confirmDel === row.name ? "בטוח?" : "✕"}
                              </button>
                            </>
                          )}
                        </td>
                      </tr>
                      {open &&
                        (() => {
                          // What-if sandbox: overrides sell-through for THIS row
                          // only, in memory. The saved scenario is never touched.
                          const savedPct = row.r.qtyAll > 0 ? row.r.totalUnits / row.r.qtyAll : 0;
                          const playing = whatIf[row.key] !== undefined;
                          const pct = whatIf[row.key] ?? savedPct;
                          const at = (p: number) =>
                            computeSim({
                              ...row.sim,
                              products: row.sim.products.map((x) => ({ ...x, sellPct: p })),
                            });
                          const w = playing ? at(pct) : row.r;
                          return (
                            <tr className="border-t border-[var(--hob-hover)] bg-[var(--hob-bg2)]">
                              <td colSpan={7} className="px-3 py-2.5">
                                {/* Jump strip — the whole curve at a glance */}
                                <div className="mb-2 rounded-md border border-[var(--hob-hover)] bg-[var(--hob-surface)] p-2">
                                  <div className="mb-1 text-[10.5px] text-[var(--hob-soft)]">
                                    מה קורה אם תמכרו — Cash Left לפי אחוז מכירה (לחיצה קופצת לשם)
                                  </div>
                                  <div className="flex flex-wrap gap-1">
                                    {[0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1].map((s) => {
                                      const c = at(s).cashProfit;
                                      const here = Math.abs(pct - s) < 0.025;
                                      return (
                                        <button
                                          key={s}
                                          type="button"
                                          onClick={() => setWhatIf((m) => ({ ...m, [row.key]: s }))}
                                          className="flex-1 rounded px-1 py-1 text-center transition-colors"
                                          style={{
                                            background: here ? "#323338" : c < 0 ? "rgba(226,68,92,.10)" : "#f6f7fb",
                                            color: here ? "#fff" : c < 0 ? "#d0453e" : "#323338",
                                          }}
                                        >
                                          <div className="text-[10px] opacity-70">{Math.round(s * 100)}%</div>
                                          <div className="text-[11px] font-bold tabular-nums dm">
                                            {c < 0 ? `-${NIS(-c)}` : NIS(c)}
                                          </div>
                                        </button>
                                      );
                                    })}
                                  </div>
                                </div>

                                {/* Fine control */}
                                <div className="mb-2 flex items-center gap-2">
                                  <span className="shrink-0 text-[11px] text-[var(--hob-soft)]">% מכירה</span>
                                  <input
                                    type="range"
                                    dir="ltr"
                                    className="w-full accent-[#037f4c]"
                                    min={0}
                                    max={1}
                                    step={0.01}
                                    value={pct}
                                    onChange={(e) =>
                                      setWhatIf((m) => ({ ...m, [row.key]: parseFloat(e.target.value) }))
                                    }
                                  />
                                  <span className="shrink-0 text-[11px] font-bold tabular-nums text-[var(--hob-ink)]">
                                    {Math.round(pct * 100)}% · {w.totalUnits} יח'
                                  </span>
                                  {playing && (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setWhatIf((m) => {
                                          const next = { ...m };
                                          delete next[row.key];
                                          return next;
                                        })
                                      }
                                      className="shrink-0 rounded-full bg-[var(--hob-hover)] px-2 py-0.5 text-[10.5px] text-[var(--hob-soft)] hover:bg-[#0073ea]/20"
                                      title={`חזרה ל-${Math.round(savedPct * 100)}% ששמור`}
                                    >
                                      ↺ חזרה לשמור
                                    </button>
                                  )}
                                </div>
                                {playing && (
                                  <div className="mb-2 rounded-md bg-[#fdab3d]/20 px-2 py-1 text-[10.5px] text-[#fdab3d] ivory:text-[#8a5a00]">
                                    🎮 משחק בלבד — התרחיש השמור נשאר על {Math.round(savedPct * 100)}%.
                                  </div>
                                )}

                                {/* Grouped so the eye knows where to go: what it
                                    costs, what comes back, then the ratios. */}
                                <div className="grid gap-x-6 sm:grid-cols-2">
                                  {([
                                    ["כמה הדרופ עולה", [
                                      ["Total Production Cost", NIS(w.productionAll), false],
                                      ["Fixed Costs", NIS(w.fixedSum), false],
                                      ["Total Upfront Cost", NIS(w.upfront), true],
                                      ["Variable Costs", NIS(w.variable), false],
                                      ["Total Landed Cost", NIS(w.landed), true],
                                    ]],
                                    ["כמה נכנס וכמה נשאר", [
                                      ["Revenue", NIS(w.gross), false],
                                      ["Gross Profit", NIS(w.grossProfit), false],
                                      ["Contribution Margin", NIS(w.contribution), false],
                                      ["Net Profit", NIS(w.profit), false],
                                      ["Unsold Inventory", `-${NIS(w.leftValue)} · ${w.leftUnits} יח'`, false],
                                    ]],
                                    ["מדדים", [
                                      ["עלות יחידה", NIS(w.unitCostRaw), false],
                                      ["עלות יחידה אחרי הוצאות כלליות", NIS(w.unitCostAfterOverhead), false],
                                      ["עלות מלאה ליחידה", NIS(w.costPerUnitSold), true],
                                      ["נקודת איזון", `${w.breakEvenUnits ?? "—"} יח'`, false],
                                      ["Gross Margin", w.net > 0 ? `${Math.round((w.grossProfit / w.net) * 100)}%` : "—", false],
                                      ["Net Margin", w.net > 0 ? `${Math.round((w.profit / w.net) * 100)}%` : "—", false],
                                    ]],
                                  ] as [string, [string, string, boolean][]][]).map(([group, items]) => (
                                    <div key={group} className="mb-1.5">
                                      <div className="mb-0.5 text-[10px] font-bold tracking-wide text-[var(--hob-faint)]">
                                        {group}
                                      </div>
                                      {items.map(([k, v, strong]) => (
                                        <div
                                          key={k}
                                          className="flex items-baseline justify-between border-b border-[var(--hob-hover)] py-1"
                                        >
                                          <span className={`text-[11.5px] ${strong ? "font-bold text-[var(--hob-ink)]" : "text-[var(--hob-soft)]"}`}>
                                            {k}
                                            {explainFor(k) && (
                                              <button
                                                type="button"
                                                onClick={() => setOpenTerm(openTerm === k ? null : k)}
                                                className="mr-1 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[var(--hob-hover)] text-[9px] font-bold text-[var(--hob-faint)] hover:bg-[#0073ea]/20"
                                                title="מה זה אומר?"
                                              >
                                                ?
                                              </button>
                                            )}
                                          </span>
                                          <span className={`text-[11.5px] tabular-nums ${strong ? "font-bold" : "font-medium"} text-[var(--hob-ink)] dm`}>
                                            {v}
                                          </span>
                                        </div>
                                      ))}
                                      {openTerm && explainFor(openTerm) && items.some(([k]) => k === openTerm) && (
                                        <div className="mt-1 rounded-md bg-[var(--hob-surface)] px-2 py-1.5 text-[11px] leading-relaxed text-[var(--hob-ink)]">
                                          <b>{openTerm}</b> — {explainFor(openTerm)}
                                        </div>
                                      )}
                                    </div>
                                  ))}
                                </div>

                                {/* The answer, given the weight it deserves */}
                                <div
                                  className="mt-1 flex items-center justify-between rounded-lg px-3 py-2"
                                  style={{ background: w.cashProfit >= 0 ? "rgba(0,200,117,.15)" : "rgba(226,68,92,.15)" }}
                                >
                                  <span className="text-[12px] font-bold text-[var(--hob-ink)]">
                                    Cash Left — מה שנשאר בפועל
                                  </span>
                                  <span
                                    className="text-lg font-extrabold tabular-nums"
                                    style={{ color: w.cashProfit >= 0 ? "#00854d" : "#e2445c" }}
                                  >
                                    {Sh(w.cashProfit)}
                                  </span>
                                </div>
                                <div className="mt-1.5 text-[10.5px] text-[var(--hob-faint)] dm-block">
                                  {row.sim.products
                                    .map((p) => `${p.name}: ${p.qty} יח' × ${NIS(p.cost)} → ${NIS(p.price)}`)
                                    .join("  ·  ")}
                                </div>
                                {/* Why this scenario exists — in two months nobody
                                    remembers why "דרופ 4 קטן" seemed smart. */}
                                <div className="mt-2 flex items-center gap-2">
                                  <span className="shrink-0 text-[10.5px] text-[var(--hob-faint)]">📝 הערה</span>
                                  <input
                                    className="w-full rounded-md border border-[var(--hob-rule)] bg-[var(--hob-surface)] px-2 py-1 text-[11.5px] focus:border-[#037f4c] focus:outline-none"
                                    placeholder="למה התרחיש הזה? (נשמר לשניכם)"
                                    defaultValue={row.sim.note ?? ""}
                                    onBlur={(e) => {
                                      const note = e.target.value.trim().slice(0, 200);
                                      if (note === (row.sim.note ?? "")) return;
                                      if (row.live) setSim({ ...sim, note });
                                      else onSave(row.name, JSON.stringify({ ...row.sim, note }));
                                    }}
                                    onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                                  />
                                </div>
                              </td>
                            </tr>
                          );
                        })()}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
</div>
  );
}

// ---- Sales pace: how the CURRENT drop is actually moving ----
// Deliberately separate from the simulator, which the partners keep for
// planning future drops — this strip reads only the real ledger.
