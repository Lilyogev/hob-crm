// 📈 Sales pace (7 days vs the 7 before, 8 weeks of bars) and the store's
// traffic card. Both read only real data: the ledger and the Shopify DO.
import { useQuery } from "@tanstack/react-query";

import { Kpi, NIS, type SalesPulse, Sh } from "./shared";

const shortDay = (d: string) => `${Number(d.slice(8, 10))}.${Number(d.slice(5, 7))}`;

// הדופק מגיע מהשרת (getSalesPulse): 7 ימים ישראליים כולל היום, אותה הגדרה כמו ב"היום שלך".
export function PaceStrip({
  pulse,
  totalSpent,
  grossRevenue,
}: {
  pulse: SalesPulse | null | undefined;
  totalSpent: number;
  grossRevenue: number;
}) {
  if (!pulse) {
    return (
      <div className="mb-3 rounded-xl bg-[var(--hob-surface)] p-4 shadow-sm">
        <div className="mb-1 flex items-baseline justify-between">
          <h3 className="text-base font-bold text-[var(--hob-ink)]">📈 דופק מכירות</h3>
          <span className="text-[11px] text-[var(--hob-faint)]">לא נבדק</span>
        </div>
        <div className="text-[12px] text-[var(--hob-soft)]">לא הצלחתי לחשב את הדופק עכשיו. זה לא אומר שאין מכירות: רעננו, או בדקו את ספר המכירות.</div>
      </div>
    );
  }
  const { last7, prev7 } = pulse;
  if (pulse.weeks.every((w) => w.units === 0)) return null;
  const unitsPerDay = last7.units / 7;
  const revPerDay = last7.revenue / 7;
  const trend = prev7.units > 0 ? Math.round(((last7.units - prev7.units) / prev7.units) * 100) : null;

  // How long until revenue has covered every shekel spent, at this pace.
  const gap = totalSpent - grossRevenue;
  const daysToCover = gap > 0 && revPerDay > 0 ? Math.ceil(gap / revPerDay) : null;

  // Last 8 weeks, oldest first. Week 0 = the 7 days ending today (Israel).
  const weeks = pulse.weeks;
  const maxUnits = Math.max(1, ...weeks.map((w) => w.units));

  return (
    <div className="mb-3 rounded-xl bg-[var(--hob-surface)] p-4 shadow-sm">
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-base font-bold text-[var(--hob-ink)]">📈 דופק מכירות</h3>
        <span className="text-[11px] text-[var(--hob-faint)]">{shortDay(last7.from)} עד {shortDay(last7.to)} (כולל היום) מול 7 הימים שלפניהם</span>
      </div>
      <div className="flex flex-wrap gap-3">
        <Kpi
          label="קצב — יחידות ליום"
          value={<span className="dm">{unitsPerDay.toFixed(1)}</span>}
          accent="#0073ea"
          sub={
            trend === null
              ? `${last7.units} יח' · ${last7.orders} הזמנות (לפי מזהה) בשבוע האחרון`
              : `${last7.units} יח' · ${last7.orders} הזמנות השבוע · ${trend >= 0 ? "▲" : "▼"} ${Math.abs(trend)}% מול שבוע קודם`
          }
        />
        <Kpi label="פדיון ליום" value={Sh(revPerDay)} accent="#00854d" sub={`שבוע אחרון: ${NIS(last7.revenue)} · שבוע קודם: ${NIS(prev7.revenue)}`} />
        <Kpi
          label="כיסוי כל ההוצאות"
          value={
            daysToCover === null ? (
              gap <= 0 ? "✓ מכוסה" : "—"
            ) : (
              <span className="dm">עוד ~{daysToCover} ימים</span>
            )
          }
          accent={gap <= 0 ? "#00854d" : "#fdab3d"}
          sub={gap > 0 ? `חסרים ${NIS(gap)} · בהנחת קצב קבוע וללא הוצאות נוספות` : "הפדיון עבר את ההוצאות"}
        />
      </div>
      {/* The number above is a verdict; this line is the lever: same maths,
          one more sale a day. */}
      {daysToCover !== null && last7.units > 0 && (
        <div className="mt-2 text-[12px] text-[var(--hob-soft)]">
          מה מקצר את זה: ב-<b className="text-[var(--hob-ink)]">{last7.units * 2}</b> יחידות בשבוע
          (במקום {last7.units}) זה יורד ל-~<b className="dm text-[var(--hob-ink)]">{Math.ceil(daysToCover / 2)}</b> ימים
          · עוד מכירה אחת ביום = ~
          <b className="dm text-[var(--hob-ink)]">
            {Math.ceil(gap / (revPerDay + last7.revenue / Math.max(1, last7.units)))}
          </b>{" "}
          ימים
        </div>
      )}
      {/* Weekly bars, oldest→newest (right→left in RTL) */}
      <div className="mt-3 flex items-end gap-1.5" style={{ height: 56 }}>
        {weeks.map((w) => (
          <div key={w.weeksAgo} className="flex flex-1 flex-col items-center justify-end gap-0.5" title={w.weeksAgo === 0 ? "השבוע" : `לפני ${w.weeksAgo} שבועות`}>
            <span className="dm text-[9.5px] text-[var(--hob-faint)]">{w.units > 0 ? w.units : ""}</span>
            <div
              className="w-full rounded-t"
              style={{
                height: `${Math.max(w.units > 0 ? 3 : 1, (w.units / maxUnits) * 40)}px`,
                background: w.weeksAgo === 0 ? "#0073ea" : "#d5e6fb",
              }}
            />
          </div>
        ))}
      </div>
      <div className="mt-0.5 flex justify-between text-[9.5px] text-[var(--hob-faint)]">
        <span>לפני 8 שבועות</span>
        <span>השבוע</span>
      </div>
      <div className="mt-1.5 text-[11px] text-[var(--hob-faint)]">מקור: {pulse.source} · ימים לפי שעון ישראל · עודכן {new Date(pulse.asOf).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" })}</div>
    </div>
  );
}

// ---- Store traffic: sessions and conversion, this week vs last ----
// Conversion is the real battle. Data flows Shopify → DO → D1 cache → here,
// refreshed at most every 45 minutes server-side.
type TrafficWeek = { sessions: number; purchases: number; conversionPct: number } | null;

export function TrafficCard() {
  const q = useQuery<{ traffic: { ts: number; t7: TrafficWeek; t14: TrafficWeek } | null }, Error>({
    queryKey: ["traffic"],
    queryFn: async () => {
      const res = await fetch("/api/finance", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "traffic" }),
      });
      if (!res.ok) throw new Error(`http ${res.status}`);
      return (await res.json()) as { traffic: { ts: number; t7: TrafficWeek; t14: TrafficWeek } | null };
    },
    staleTime: 30 * 60 * 1000,
    refetchInterval: 30 * 60 * 1000,
    retry: 1,
  });
  const t7 = q.data?.traffic?.t7 ?? null;
  const t14 = q.data?.traffic?.t14 ?? null;
  if (!t7) return null; // not configured / first fetch failed — take no space

  // Last week = the 14-day window minus this week's share.
  const prev =
    t14 && t14.sessions >= t7.sessions
      ? { sessions: t14.sessions - t7.sessions, purchases: t14.purchases - t7.purchases }
      : null;
  const prevConv = prev && prev.sessions > 0 ? (prev.purchases / prev.sessions) * 100 : null;
  const convDelta = prevConv !== null ? t7.conversionPct - prevConv : null;
  const pct = (v: number) => `${v.toFixed(2)}%`;

  return (
    <div className="mb-3 rounded-xl bg-[var(--hob-surface)] p-4 shadow-sm">
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-base font-bold text-[var(--hob-ink)]">🛍 החנות אונליין</h3>
        <span className="text-[11px] text-[var(--hob-faint)]">7 ימים אחרונים מול הקודמים · מתעדכן כל ~45 דק'</span>
      </div>
      <div className="flex flex-wrap gap-3">
        <Kpi
          label="כניסות לאתר"
          value={<span className="dm">{t7.sessions.toLocaleString("en-US")}</span>}
          accent="#0073ea"
          sub={prev ? `שבוע קודם: ${prev.sessions.toLocaleString("en-US")}` : undefined}
        />
        <Kpi
          label="קניות אונליין"
          value={<span className="dm">{t7.purchases}</span>}
          accent="#00854d"
          sub={prev ? `שבוע קודם: ${prev.purchases}` : undefined}
        />
        <Kpi
          label="המרה"
          value={<span className="dm">{pct(t7.conversionPct)}</span>}
          accent={convDelta === null ? "#323338" : convDelta >= 0 ? "#00854d" : "#e2445c"}
          sub={
            prevConv === null
              ? "קניות ÷ כניסות"
              : `שבוע קודם: ${pct(prevConv)} · ${convDelta! >= 0 ? "▲ משתפרת" : "▼ יורדת"}`
          }
        />
      </div>
    </div>
  );
}
