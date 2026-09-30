// "היום שלך" — בראש טאב המשימות. מה מצב העסק, מה דורש טיפול ומה הפעולה הבאה,
// בכמה שניות: עד שלוש פעולות מתועדפות, שלושה מספרי כסף נפרדים, ותהליך משלוח
// שלם (רשימת אריזה → עדכון באישור → טיוטת הודעה → מה נשאר). הנתונים מ-/api/today.
// "בוצע" מוצג רק אחרי תשובת שרת; מה שלא ידוע מוצג כ"לא נבדק", לא כאפס.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { api, post } from "./board";
import { toast } from "./toast";
import { type FigureState, figureMeta } from "../../lib/figure";

type OrderLine = { id: number; label: string; size: string; qty: number; price: number; status: string; location: string; locationHe: string };
type Order = { key: string; ref: string; noRef: boolean; buyer: string; firstName: string; city: string; phone: string; days: number; workDays: number; late: boolean; delivery: "" | "ship" | "pickup" | "hand"; deliveryAssumed: boolean; total: number; lines: OrderLine[]; locations: string[]; saleIds: number[]; blockers: string[]; cancelledLines: number; draft: string; missing: string[]; shipState?: "not_shipped" | "shipped_unrecorded" | "shipped"; shipLabel?: string };
const DELIVERY_HE: Record<string, string> = { ship: "משלוח", pickup: "איסוף עצמי", hand: "מסירה ביד", "": "לא צוין" };
type Lead = { id: number; name: string; city: string; followup: string; daysLate: number; phone: string; draft: string; missing: string[] };
type Card = { id: string; level: "red" | "orange"; who: string; title: string; why: string; minutes: number; urgent: boolean; kind: "ship" | "decision" | "leads" | "tasks"; href?: string; orders?: Order[]; leads?: Lead[]; tasks?: { id: number; title: string; who: string; days: number; team?: boolean }[]; decisionId?: number; options?: { label: string; preview: string; auto?: boolean }[] };
type Action = { id: number; title: string; change: string; state: "waiting" | "running" | "done" | "failed" | "unknown"; result: string; at: string };
type Money = {
  revenue7: { value: number | null; orders: number | null; from: string | null; to: string | null; source: string; asOf: string | null };
  bank: { value: number | null; asOf: string | null; source: string; state: FigureState | null; note: string | null };
  expected: { value: number | null; asOf: string | null; source: string; state: FigureState | null; note: string | null };
  updatedAt: string;
};
type State = { ok: boolean; cards: Card[]; failed: string[]; money: Money; actions: Action[]; line: string; doneToday: number };

const RED = "#e2445c";
const ORANGE = "#fdab3d";
const GREEN = "#00c875";
const STATE: Record<Action["state"], { label: string; color: string }> = {
  waiting: { label: "ממתין לאישור", color: ORANGE },
  running: { label: "בביצוע", color: "var(--hob-soft)" },
  done: { label: "בוצע", color: GREEN },
  failed: { label: "נכשל", color: RED },
  unknown: { label: "לא ידוע אם בוצע", color: ORANGE },
};
const nis = (n: number) => `${Math.round(n).toLocaleString("en-US")} ₪`;
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });
const shortDay = (d: string) => `${Number(d.slice(8, 10))}.${Number(d.slice(5, 7))}`;

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast("הועתק");
  } catch {
    toast("לא הצלחתי להעתיק. סמן את הטקסט והעתק ידנית");
  }
}

function Draft({ text, missing }: { text: string; missing: string[] }) {
  return (
    <>
      {text ? <div className="my-1.5 whitespace-pre-wrap rounded-lg border border-[var(--hob-rule)] bg-[var(--hob-bg)] p-2.5 text-[14.5px] leading-relaxed text-[var(--hob-ink)]">{text}</div> : null}
      {missing.map((m) => (
        <div key={m} className="mb-1 text-[13px]" style={{ color: ORANGE }}>חסר: {m}</div>
      ))}
      {text ? (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => void copy(text)} className="min-h-[38px] rounded-lg border border-[var(--hob-rule-strong)] px-3.5 text-[13.5px] font-medium text-[var(--hob-ink)]">העתק הודעה</button>
          <span className="text-[11.5px] text-[var(--hob-faint)]">השליחה רק על ידך. המערכת לא שולחת הודעות ללקוחות.</span>
        </div>
      ) : null}
    </>
  );
}

export function ShipFlow({ orders, actions, onPrepare, onDelivery, onMerge }: { orders: Order[]; actions: Action[]; onPrepare: (o: Order) => void; onDelivery: (o: Order, mode: "ship" | "pickup" | "hand") => void; onMerge: (saleIds: number[]) => void }) {
  const [openKey, setOpenKey] = useState(orders[0]?.key ?? "");
  const [packed, setPacked] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem("hob_today_packed") || "{}") as Record<string, boolean>;
    } catch {
      return {};
    }
  });
  const tick = (k: string, v: boolean) => {
    const next = { ...packed, [k]: v };
    setPacked(next);
    try {
      localStorage.setItem("hob_today_packed", JSON.stringify(next));
    } catch {
      /* private mode */
    }
  };
  return (
    <div className="border-t border-[var(--hob-rule)] bg-[var(--hob-bg2)] p-3">
      {orders.map((o) => {
        const open = o.key === openKey;
        const lineKeys = [...o.lines.map((l) => `${o.key}:${l.id}`), `${o.key}:letter`];
        const allPacked = lineKeys.every((k) => packed[k]);
        const mine = actions.find((a) => o.saleIds.some((id) => a.change.includes(`#${id} `) || a.change.includes(`#${id},`) || a.change.endsWith(`#${id}`)));
        return (
          <div key={o.key} className="mb-2 rounded-xl border border-[var(--hob-rule)] bg-[var(--hob-surface)]">
            <button type="button" onClick={() => setOpenKey(open ? "" : o.key)} className="flex min-h-[48px] w-full items-center justify-between gap-2 px-3 py-2 text-start">
              <span className="min-w-0">
                <span className="block truncate text-[14.5px] font-semibold text-[var(--hob-ink)]">{o.buyer} {o.ref && <span className="hob-mono text-xs text-[var(--hob-faint)]">{o.ref}</span>}{o.noRef && <span className="text-xs text-[var(--hob-faint)]"> · רשומה ידנית, בלי מזהה הזמנה</span>}</span>
                <span className="block text-xs text-[var(--hob-faint)]">{o.lines.length} פריטים · {nis(o.total)}{o.city ? ` · ${o.city}` : ""} · {DELIVERY_HE[o.delivery]}{o.blockers.length ? <span style={{ color: ORANGE }}> · {o.blockers.length} חסמים</span> : null}</span>
                {/* לא נשלח מול נשלח-ולא-עודכן: מהראיה שעל השורות (מספר מעקב או "נשלח:"), לא ניחוש */}
                {o.shipLabel && <span className="block text-xs" style={{ color: o.shipState === "shipped_unrecorded" ? ORANGE : "var(--hob-faint)" }}>{o.shipLabel}</span>}
              </span>
              <span className="shrink-0 text-xs font-semibold" style={{ color: o.late ? RED : "var(--hob-soft)" }}>{o.workDays === 0 ? "מהיום" : o.workDays === 1 ? "יום עבודה אחד" : `${o.workDays} ימי עבודה`}</span>
            </button>
            {open && (
              <div className="border-t border-[var(--hob-rule)] px-3 pb-3 pt-1">
                {o.blockers.length > 0 && (
                  <div className="mt-2 rounded-lg border border-[#fdab3d]/50 bg-[var(--hob-bg)] px-2.5 py-2 text-[13px]" style={{ color: ORANGE }}>
                    {o.blockers.map((b) => <div key={b}>חסם: {b}</div>)}
                  </div>
                )}
                {o.cancelledLines > 0 && <div className="mt-1 text-xs text-[var(--hob-faint)]">{o.cancelledLines} שורות בהזמנה בוטלו ולא מופיעות כאן.</div>}
                {o.noRef && (() => {
                  // רשומות ידניות של אותו קונה: הלוח לא מאחד לבד, יוגב מחליט.
                  const siblings = orders.filter((x) => x.noRef && x.key !== o.key && x.buyer === o.buyer);
                  if (!siblings.length) return null;
                  const ids = [...o.saleIds, ...siblings.flatMap((x) => x.saleIds)];
                  return (
                    <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-[var(--hob-bg)] px-2.5 py-2 text-[13px] text-[var(--hob-soft)]">
                      <span>יש עוד {siblings.length} רשומות ידניות של {o.firstName || o.buyer} בלי מזהה הזמנה.</span>
                      <button type="button" onClick={() => onMerge(ids)} className="rounded-lg border border-[var(--hob-rule-strong)] px-2.5 py-1 text-xs text-[var(--hob-ink)]">זו הזמנה אחת, לחבר</button>
                    </div>
                  );
                })()}
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-[var(--hob-faint)]">
                  <span>מסירה:</span>
                  {(["ship", "pickup", "hand"] as const).map((m) => (
                    <button key={m} type="button" onClick={() => onDelivery(o, m)} className="rounded-full border px-2.5 py-1 text-xs" style={o.delivery === m ? { borderColor: "var(--hob-accent)", background: "var(--hob-accent)", color: "var(--hob-accent-fg)" } : { borderColor: "var(--hob-rule-strong)", color: "var(--hob-soft)" }}>{DELIVERY_HE[m]}</button>
                  ))}
                  {o.deliveryAssumed && <span>לא צוין בהזמנה</span>}
                </div>
                <div className="mt-2 text-[13px] font-semibold text-[var(--hob-ink)]">1 · רשימת אריזה</div>
                {o.lines.map((l) => (
                  <label key={l.id} className="flex min-h-[40px] items-center gap-2.5 text-[14.5px] text-[var(--hob-ink)]">
                    <input type="checkbox" className="h-5 w-5 flex-none" style={{ accentColor: GREEN }} checked={Boolean(packed[`${o.key}:${l.id}`])} onChange={(e) => tick(`${o.key}:${l.id}`, e.target.checked)} />
                    <span>{l.label}{l.size ? ` · ${l.size}` : ""}{l.qty > 1 ? ` × ${l.qty}` : ""} <span className="text-xs text-[var(--hob-faint)]">· {l.locationHe}</span></span>
                  </label>
                ))}
                <label className="flex min-h-[40px] items-center gap-2.5 text-[14.5px] text-[var(--hob-ink)]">
                  <input type="checkbox" className="h-5 w-5 flex-none" style={{ accentColor: GREEN }} checked={Boolean(packed[`${o.key}:letter`])} onChange={(e) => tick(`${o.key}:letter`, e.target.checked)} />
                  <span>מכתב THE DREAMERS + מדבקה</span>
                </label>
                {o.phone && <div className="text-xs text-[var(--hob-faint)]">טלפון: <span className="hob-mono">{o.phone}</span></div>}

                <div className={`mt-3 ${allPacked ? "" : "opacity-45"}`}>
                  <div className="text-[13px] font-semibold text-[var(--hob-ink)]">2 · עדכון משלוח</div>
                  <div className="my-1.5 rounded-lg border border-dashed border-[var(--hob-rule-strong)] bg-[var(--hob-bg)] px-2.5 py-2 text-[13.5px] text-[var(--hob-soft)]">
                    מה ישתנה: {o.lines.map((l) => `#${l.id}`).join(", ")} של {o.firstName || o.buyer} יסומנו <b className="text-[var(--hob-ink)]">נשלח</b>. שום דבר אחר.
                  </div>
                  {mine ? (
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-[var(--hob-faint)]">הפרטים והכפתורים ב״מעקב פעולות״ למטה</span>
                      <span className="rounded-md px-2 py-0.5 text-xs font-bold" style={{ color: STATE[mine.state].color, background: "var(--hob-hover)" }}>{STATE[mine.state].label}</span>
                    </div>
                  ) : (
                    <>
                      <button type="button" disabled={!allPacked} onClick={() => onPrepare(o)} className="min-h-[44px] rounded-[10px] bg-[var(--hob-accent)] px-4 text-[14.5px] font-bold text-[var(--hob-accent-fg)] disabled:opacity-50">
                        הכן לאישור
                      </button>
                      {!allPacked && <div className="mt-1.5 text-xs text-[var(--hob-faint)]">סמן קודם את כל הפריטים ברשימת האריזה.</div>}
                    </>
                  )}
                </div>

                <div className="mt-3">
                  <div className="text-[13px] font-semibold text-[var(--hob-ink)]">3 · טיוטת הודעה ללקוח</div>
                  <div className="text-xs text-[var(--hob-faint)]">הקשר: {o.buyer}{o.ref ? `, הזמנה ${o.ref}` : ""}, {o.lines.length} פריטים, מחכה {o.workDays} ימי עבודה.</div>
                  <Draft text={o.draft} missing={o.missing} />
                </div>
              </div>
            )}
          </div>
        );
      })}
      <div className="px-1 text-xs text-[var(--hob-faint)]">4 · מה נשאר: {orders.length === 1 ? "זו ההזמנה האחרונה שמחכה." : `${orders.length} הזמנות מחכות. כל אחת שתסומן כנשלחה תרד מהרשימה.`}</div>
    </div>
  );
}

function LeadsFlow({ leads }: { leads: Lead[] }) {
  return (
    <div className="border-t border-[var(--hob-rule)] bg-[var(--hob-bg2)] p-3">
      {leads.map((l) => (
        <div key={l.id} className="mb-2 rounded-xl border border-[var(--hob-rule)] bg-[var(--hob-surface)] p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[14.5px] font-semibold text-[var(--hob-ink)]">{l.name}{l.city ? ` · ${l.city}` : ""}</span>
            <span className="text-xs text-[var(--hob-faint)]">מעקב {shortDay(l.followup)} · {l.daysLate === 0 ? "היום" : `לפני ${l.daysLate} ימים`}</span>
          </div>
          <Draft text={l.draft} missing={l.missing} />
        </div>
      ))}
      <a href="/?tab=bizdev" className="text-[13px] text-[var(--hob-soft)] underline underline-offset-4">לעדכן סטטוס ותאריך מעקב בטאב ההפצה</a>
    </div>
  );
}

export function TodayView({ onAuthLost }: { onAuthLost: () => void }) {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ["today"], queryFn: () => api<State>("/api/today"), refetchInterval: 120_000 });
  useEffect(() => {
    if (query.error && (query.error as Error).message === "unauthorized") onAuthLost();
  }, [query.error, onAuthLost]);

  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  // משימה שלא זזה (של הצוות או כל משימה פתוחה בלוח): "סיימתי" או "לא רלוונטי".
  const taskM = useMutation({
    mutationFn: (v: { id: number; done: boolean; team?: boolean }) => post("/api/today", { op: v.done ? "task_done" : "task_drop", id: v.id }) as Promise<{ ok: boolean }>,
    onSuccess: (r, v) => {
      toast(r.ok ? (v.done ? (v.team ? "סומנה כבוצעה. העובד יראה את זה בריצה הבאה" : "סומנה כבוצעה") : "נסגרה כלא רלוונטית") : "המשימה כבר נסגרה או לא נמצאה");
      refresh();
      // אותה משימה מופיעה גם בלוח שמתחת.
      void qc.invalidateQueries({ queryKey: ["board"] });
    },
  });
  // "מעכשיו תעשה את זה לבד" על ההכרעה הפתוחה.
  const [always, setAlways] = useState(false);
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem("hob_today_collapsed") === "1";
    } catch {
      return false;
    }
  });
  const toggleCollapsed = () => {
    setCollapsed((v) => {
      try {
        localStorage.setItem("hob_today_collapsed", v ? "0" : "1");
      } catch {
        /* private mode */
      }
      return !v;
    });
  };
  const [snoozeFor, setSnoozeFor] = useState<string | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["today"] });
    void qc.invalidateQueries({ queryKey: ["seeding"] });
  };

  const mergeM = useMutation({
    mutationFn: (sale_ids: number[]) => post("/api/today", { op: "merge", sale_ids }) as Promise<{ ok: boolean; error?: string }>,
    onSuccess: (r) => {
      toast(r.ok ? "חובר להזמנה אחת" : `לא חובר: ${r.error ?? "שגיאה"}`);
      void qc.invalidateQueries({ queryKey: ["today"] });
    },
  });
  const deliveryM = useMutation({
    mutationFn: (v: { sale_ids: number[]; delivery: "ship" | "pickup" | "hand" }) => post("/api/today", { op: "delivery", ...v }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["today"] }),
  });
  const prepareM = useMutation({
    meta: { ownErrorMessage: true },
    mutationFn: (o: Order) => post("/api/today", { op: "prepare", sale_ids: o.saleIds, status: "shipped" }) as Promise<{ ok: boolean; error?: string }>,
    onSuccess: (r) => {
      toast(r.ok ? "מחכה לאישור שלך ב״מעקב פעולות״" : "לא הצלחתי להכין את העדכון. השורות לא נמצאו בלוח");
      refresh();
    },
    onError: () => toast("אין תשובה מהשרת. שום דבר לא השתנה"),
  });
  const confirmM = useMutation({
    meta: { ownErrorMessage: true },
    mutationFn: (id: number) => post("/api/today", { op: "confirm", id }) as Promise<{ ok: boolean; state: Action["state"]; text: string }>,
    onSuccess: (r) => {
      toast(r.state === "done" ? `בוצע. ${r.text}` : r.state === "running" ? r.text : `לא בוצע: ${r.text}`);
      refresh();
    },
    // בלי "נסה שוב" עיוור: מרעננים את המצב מהשרת, והוא יגיד אם זה בוצע, נכשל או לא ידוע.
    onError: () => {
      toast("אין תשובה מהשרת. בודק מה מצב הפעולה");
      refresh();
    },
  });
  const decideM = useMutation({
    meta: { ownErrorMessage: true },
    mutationFn: (v: { id: number; option: number; always?: boolean }) => post("/api/team", { op: "decide", ...v }) as Promise<{ ok: boolean; status?: string; result?: string; already?: boolean; error?: string; rule?: { ok: boolean; id?: number; error?: string } }>,
    onSuccess: (r) => {
      if (r.error === "in_progress") toast("ההכרעה הזו כבר מתבצעת, לא שלחתי שוב");
      else if (r.already) toast(`כבר בוצע קודם: ${r.result || "נרשם"}`);
      else if (r.status === "failed") toast(`לא בוצע: ${r.result ?? ""}`);
      else if (r.status === "partial") toast(`בוצע חלקית. ${r.result ?? ""}`);
      else toast(r.result || "הוכרע");
      if (r.rule?.ok) toast(`נשמר כלל #${r.rule.id}: בפעם הבאה העובד יעשה את זה לבד וידווח`);
      else if (r.rule && !r.rule.ok) toast(`הכלל לא נשמר: ${r.rule.error ?? ""}`);
      setAlways(false);
      setOpen(null);
      refresh();
      void qc.invalidateQueries({ queryKey: ["team"] });
      void qc.invalidateQueries({ queryKey: ["board"] });
    },
    onError: () => {
      toast("אין תשובה מהשרת. בודק מה מצב ההכרעה לפני שלוחצים שוב");
      refresh();
    },
  });
  const cancelM = useMutation({ mutationFn: (id: number) => post("/api/today", { op: "cancel", id }), onSuccess: refresh });
  const snoozeM = useMutation({
    mutationFn: (v: { card: string; days: number }) => post("/api/today", { op: "snooze", ...v }) as Promise<{ until: string }>,
    onSuccess: (r) => {
      toast(`נדחה. יחזור ב-${shortDay(r.until)}`);
      setSnoozeFor(null);
      refresh();
    },
  });

  if (query.isLoading) return <div className="mb-6 py-6 text-center text-sm text-[var(--hob-faint)]">טוען את היום שלך…</div>;
  const data = query.data;
  if (!data) {
    return <div className="mb-6 rounded-xl border border-dashed border-[var(--hob-rule-strong)] px-4 py-5 text-center text-sm" style={{ color: ORANGE }}>לא הצלחתי לטעון את ״היום שלך״. זה לא אומר שאין מה לעשות: רענן, או בדוק את טאב החלוקות.</div>;
  }
  const shown = showAll ? data.cards : data.cards.slice(0, 3);
  const later = data.cards.length - shown.length;
  const m = data.money;
  // זיכוי אחרון שנרשם לפני יותר משבועיים, ועדיין "צפוי להיכנס" כסף: כנראה חלק כבר
  // נחת בבנק ולא נרשם. אומרים את זה, במקום להציג שני מספרים שנראים בטוחים.
  const staleDays = m.bank.asOf ? Math.floor((Date.now() - Date.parse(`${m.bank.asOf}T12:00:00Z`)) / 86400000) : 0;
  const stale = staleDays > 14 && (m.expected.value ?? 0) > 0;
  // "בבנק" = יתרת פתיחה + הפקדות שנרשמו ביד. בלי הפקדה רשומה מעל שבועיים המספר הוא
  // ניחוש, אז לא מציגים מספר: "לא ידוע", למה, ולחיצה אחת לרישום הפקדה.
  const bankUnknown = m.bank.value !== null && Boolean(m.bank.asOf) && staleDays > 14;
  const logDeposit = "/?tab=finance&log=settlement";
  const pendingActions = data.actions;
  const urgentCount = data.cards.filter((c) => c.urgent).length;

  return (
    <section className="mx-auto mb-6 max-w-3xl" dir="rtl">
      {/* שורת כותרת אחת: שם, סיכום של ברונו, בחירת זמן. הכל מצומצם כדי שהלוח עצמו
          יישאר מעל הקפל; הפירוט נפתח בלחיצה על שורה. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <button type="button" onClick={toggleCollapsed} className="flex items-center gap-1.5 text-[17px] font-bold text-[var(--hob-ink)]" aria-expanded={!collapsed}>
          <span className={`inline-block text-xs transition-transform ${collapsed ? "-rotate-90" : ""}`} aria-hidden>▾</span>
          היום שלך
          {urgentCount > 0 && <span className="hob-mono rounded-full px-1.5 text-[11px] font-bold text-white" style={{ background: RED }}>{urgentCount}</span>}
        </button>
        <span className="ms-auto flex items-center gap-2 text-xs text-[var(--hob-faint)]">
          {data.doneToday > 0 && <span style={{ color: GREEN }}>✓ {data.doneToday} נסגרו היום</span>}
          <button type="button" onClick={refresh} title={`עודכן ${hhmm(m.updatedAt)}`} className="h-7 px-1">עודכן {hhmm(m.updatedAt)} ↻</button>
        </span>
      </div>

      {!collapsed && (
        <>
          <div className="mt-1.5 text-[13.5px] leading-snug text-[var(--hob-soft)]">🤖 {data.line}</div>

          {/* שלושת מספרי הכסף בשורה אחת. מצב נוכחי (לא דוח היסטורי): כל מספר עם התאריך והמקור שלו */}
          <div className="mt-2 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--hob-faint)]">מצב נוכחי</div>
          <a href={bankUnknown ? logDeposit : "/?tab=finance"} title={bankUnknown ? "לרישום הפקדה בטאב הכספים" : "לטאב הכספים"} className="mt-0.5 flex flex-wrap items-baseline gap-x-4 gap-y-0.5 rounded-lg border border-[var(--hob-rule)] bg-[var(--hob-surface)] px-3 py-1.5 text-[12.5px] text-[var(--hob-faint)] hover:border-[var(--hob-rule-strong)]">
            {([
              ["הכנסות 7 ימים", m.revenue7.value, `${m.revenue7.orders === null ? "" : `${m.revenue7.orders} הזמנות (לפי מזהה הזמנה) · `}${m.revenue7.from && m.revenue7.to ? `${shortDay(m.revenue7.from)} עד ${shortDay(m.revenue7.to)}, כולל היום` : "7 ימים קלנדריים"} · ${m.revenue7.source} · נמכר, לא בהכרח נכנס לבנק`],
              ["בבנק", bankUnknown ? "unknown" : m.bank.value, `לפי הלוח, לא דף הבנק${m.bank.asOf ? ` · זיכוי אחרון נרשם ${shortDay(m.bank.asOf)}` : ""}`],
              ["צפוי להיכנס", m.expected.value, "מכירות בסליקה שלא נרשם להן זיכוי בלוח (ברוטו). ייתכן שחלק כבר נכנס לבנק ולא נרשם"],
            ] as const).map(([label, value, note]) => (
              <span key={label} className="whitespace-nowrap" title={note}>
                {label}{" "}
                {value === "unknown" ? (
                  <>
                    <b className="hob-mono text-[14px]" style={{ color: ORANGE }}>{nis(m.bank.value ?? 0)}</b> <span className="text-[11.5px]" style={{ color: ORANGE }}>לפי הרישומים, לא אומת מול הבנק {staleDays} ימים</span>
                  </>
                ) : value === null ? <b style={{ color: ORANGE }}>לא נבדק</b> : <b className="hob-mono text-[14px] text-[var(--hob-ink)]">{nis(value)}</b>}
              </span>
            ))}
            {bankUnknown && (
              <span className="basis-full sm:basis-auto">
                <span className="inline-flex h-7 items-center rounded-lg bg-[var(--hob-accent)] px-2.5 text-[12px] font-bold text-[var(--hob-accent-fg)]">רשום הפקדה</span>
              </span>
            )}
            {stale && !bankUnknown && (
              <span className="basis-full text-[11.5px] leading-snug sm:basis-auto" style={{ color: ORANGE }} title="רשום את הזיכויים בטאב הכספים כדי ששני המספרים יהיו מדויקים">
                ⚠ זיכוי אחרון נרשם לפני {staleDays} ימים. בנק וצפוי לא מדויקים · לחץ לרישום
              </span>
            )}
            {/* מקור · עודכן · מצב, בגלוי ולא רק בטולטיפ. אותן מילים כמו בטאב הכספים (FIGURE_STATE_HE). */}
            <span className="basis-full text-[11px] leading-snug text-[var(--hob-faint)]">
              הכנסות: {m.revenue7.from && m.revenue7.to ? `${shortDay(m.revenue7.from)} עד ${shortDay(m.revenue7.to)}, כולל היום` : "7 ימים"} · {m.revenue7.source}
              {" · "}בנק: {m.bank.value === null ? "לא נבדק" : figureMeta(m.bank)}{m.bank.note ? ` · ${m.bank.note}` : ""}
              {" · "}צפוי: {m.expected.value === null ? "לא נבדק" : figureMeta(m.expected)}
            </span>
          </a>

          {shown.length === 0 && (
            <div className="mt-2 rounded-lg border border-dashed border-[var(--hob-rule-strong)] px-3 py-2.5 text-center text-[13px] text-[var(--hob-soft)]">
              ✓ אין משהו שדורש אותך עכשיו. אין הזמנות שמחכות, אין הכרעות פתוחות וכל המעקבים בזמן.
            </div>
          )}

          <div className="mt-2 overflow-hidden rounded-xl border border-[var(--hob-rule)] bg-[var(--hob-surface)] empty:hidden">
            {shown.map((c) => {
              const color = c.level === "red" ? RED : ORANGE;
              const isOpen = open === c.id;
              const expandable = c.kind !== "decision" || Boolean(c.options?.length);
              return (
                <div key={c.id} className="border-b border-[var(--hob-rule)] last:border-b-0" style={{ borderInlineStart: `3px solid ${color}` }}>
                  <div className="flex items-center gap-2.5 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="truncate text-[14.5px] font-semibold text-[var(--hob-ink)]">{c.title}</span>
                      </div>
                      {c.why && <div className={`text-[12.5px] leading-snug text-[var(--hob-soft)] ${isOpen ? "" : "truncate"}`}>{c.who} · {c.why}</div>}
                      {c.kind === "ship" && c.orders && !isOpen && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {c.orders.slice(0, 6).map((o) => (
                            <span key={o.key} className="rounded-md px-1.5 py-px text-[11.5px]" style={{ background: "var(--hob-hover)", color: o.days > 2 ? RED : "var(--hob-soft)" }}>
                              {o.firstName || o.buyer} · {o.days === 0 ? "היום" : `${o.days} י׳`}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    {!c.urgent && (
                      <button type="button" onClick={() => setSnoozeFor(snoozeFor === c.id ? null : c.id)} className="shrink-0 text-xs text-[var(--hob-faint)] underline underline-offset-2">לא עכשיו</button>
                    )}
                    {expandable ? (
                      <button type="button" onClick={() => setOpen(isOpen ? null : c.id)} className="h-9 shrink-0 rounded-lg bg-[var(--hob-accent)] px-3 text-[13px] font-bold text-[var(--hob-accent-fg)]">
                        {isOpen ? "סגור" : c.kind === "ship" ? "רשימת אריזה" : c.kind === "leads" ? "טיוטות" : c.kind === "tasks" ? "טפל" : "הכרע"}
                      </button>
                    ) : (
                      <a href={c.href} className="inline-flex h-9 shrink-0 items-center rounded-lg bg-[var(--hob-accent)] px-3 text-[13px] font-bold text-[var(--hob-accent-fg)]">להכרעה</a>
                    )}
                  </div>
                  {snoozeFor === c.id && (
                    <div className="flex flex-wrap gap-1.5 px-3 pb-2">
                      {([[1, "מחר בבוקר"], [3, "בעוד 3 ימים"], [7, "בשבוע הבא"]] as const).map(([days, label]) => (
                        <button key={days} type="button" onClick={() => snoozeM.mutate({ card: c.id, days })} className="h-8 rounded-lg border border-[var(--hob-rule-strong)] px-2.5 text-[12.5px] text-[var(--hob-ink)]">{label}</button>
                      ))}
                    </div>
                  )}
                  {isOpen && c.kind === "ship" && c.orders && <ShipFlow orders={c.orders} actions={pendingActions} onPrepare={(o) => prepareM.mutate(o)} onDelivery={(o, mode) => deliveryM.mutate({ sale_ids: o.saleIds, delivery: mode })} onMerge={(ids) => mergeM.mutate(ids)} />}
                  {isOpen && c.kind === "leads" && c.leads && <LeadsFlow leads={c.leads} />}
                  {isOpen && c.kind === "tasks" && c.tasks && (
                    <div className="border-t border-[var(--hob-rule)] bg-[var(--hob-bg2)] p-3">
                      {c.tasks.map((t) => (
                        <div key={t.id} className="flex flex-wrap items-center gap-2 border-b border-[var(--hob-rule)] py-2 last:border-b-0">
                          <div className="min-w-0 flex-1">
                            <div className="text-sm text-[var(--hob-ink)]">{t.title}</div>
                            <div className="text-[11.5px] text-[var(--hob-faint)]">
                              {t.team === false ? `לא זזה ${t.days} ימים` : `${t.who} · לפני ${t.days} ימים`}
                            </div>
                          </div>
                          <button type="button" disabled={taskM.isPending} onClick={() => taskM.mutate({ id: t.id, done: true, team: t.team })} className="h-8 rounded-lg bg-[var(--hob-accent)] px-3 text-[12.5px] font-bold text-[var(--hob-accent-fg)] disabled:opacity-50">
                            סיימתי
                          </button>
                          <button type="button" disabled={taskM.isPending} onClick={() => taskM.mutate({ id: t.id, done: false, team: t.team })} className="h-8 rounded-lg border border-[var(--hob-rule-strong)] px-3 text-[12.5px] text-[var(--hob-ink)] disabled:opacity-50">
                            לא רלוונטי
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  {isOpen && c.kind === "decision" && c.options && c.decisionId && (
                    <div className="border-t border-[var(--hob-rule)] bg-[var(--hob-bg2)] p-3">
                      {/* מכריעים מכאן, בלי לעבור לטאב ברונו. מתחת לכל אפשרות: מה בדיוק ישתנה. */}
                      <div className="flex flex-col gap-1.5">
                        {c.options.map((o, i) => (
                          <button
                            key={o.label}
                            type="button"
                            disabled={decideM.isPending}
                            onClick={() => decideM.mutate({ id: c.decisionId as number, option: i, always: always && Boolean(o.auto) })}
                            className="rounded-lg border border-[var(--hob-rule-strong)] bg-[var(--hob-surface)] px-3 py-2 text-start hover:bg-[var(--hob-hover)] disabled:opacity-50"
                          >
                            <span className="block text-sm text-[var(--hob-ink)]">{o.label}</span>
                            {o.preview && <span className="mt-0.5 block text-[11.5px] leading-snug text-[var(--hob-faint)]">{o.preview}</span>}
                            {always && o.auto && <span className="mt-0.5 block text-[11.5px] text-[var(--hob-accent)]">+ מעכשיו העובד יעשה את זה לבד</span>}
                          </button>
                        ))}
                      </div>
                      {c.options.some((o) => o.auto) && (
                        <label className="mt-2 flex cursor-pointer items-start gap-2 text-[12.5px] leading-snug text-[var(--hob-soft)]">
                          <input type="checkbox" checked={always} onChange={(e) => setAlways(e.target.checked)} className="mt-0.5" />
                          <span>מעכשיו תעשה את זה לבד כשזה חוזר (רק פעולות בתוך הלוח; סימון הזמנות נשאר אצלך)</span>
                        </label>
                      )}
                      <a href="/?tab=bruno" className="mt-2 inline-block text-xs text-[var(--hob-faint)] underline underline-offset-2">עוד אפשרויות (במילים שלי, לא עכשיו) בטאב ברונו</a>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {(later > 0 || showAll) && data.cards.length > 3 && (
            <button type="button" onClick={() => setShowAll((v) => !v)} className="mt-1 w-full text-center text-xs text-[var(--hob-faint)] hover:text-[var(--hob-ink)]">
              {showAll ? "רק שלוש הראשונות" : `ועוד ${later} פחות דחופות`}
            </button>
          )}

      {pendingActions.length > 0 && (
        <>
          <div className="mb-1.5 mt-5 px-0.5 text-[12.5px] text-[var(--hob-faint)]">מעקב פעולות</div>
          <div className="rounded-[14px] border border-[var(--hob-rule)] bg-[var(--hob-surface)] px-3">
            {pendingActions.map((a) => (
              <div key={a.id} className="border-b border-[var(--hob-rule)] py-2.5 last:border-b-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-[var(--hob-ink)]">{a.title}</span>
                  <span className="whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-bold" style={{ color: STATE[a.state].color, background: "var(--hob-hover)" }}>{STATE[a.state].label}</span>
                </div>
                <div className="text-xs text-[var(--hob-faint)]">{a.state === "done" || a.state === "failed" ? a.result : a.change}</div>
                {a.state === "waiting" && (
                  <div className="mt-1.5 flex gap-2">
                    <button type="button" disabled={confirmM.isPending} onClick={() => confirmM.mutate(a.id)} className="min-h-[38px] rounded-lg bg-[var(--hob-accent)] px-3.5 text-[13.5px] font-bold text-[var(--hob-accent-fg)] disabled:opacity-50">אשר ובצע</button>
                    <button type="button" onClick={() => cancelM.mutate(a.id)} className="min-h-[38px] rounded-lg border border-[var(--hob-rule-strong)] px-3.5 text-[13.5px] text-[var(--hob-ink)]">בטל</button>
                  </div>
                )}
                {(a.state === "failed" || a.state === "unknown") && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                    <button type="button" disabled={confirmM.isPending} onClick={() => confirmM.mutate(a.id)} className="min-h-[38px] rounded-lg border border-[var(--hob-rule-strong)] px-3.5 text-[13.5px] text-[var(--hob-ink)] disabled:opacity-50">
                      {a.state === "unknown" ? "בדוק והשלם" : "נסה שוב"}
                    </button>
                    <span className="text-[11.5px] text-[var(--hob-faint)]">בטוח: שורה שכבר סומנה לא משתנה שוב.</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
        </>
      )}
    </section>
  );
}
