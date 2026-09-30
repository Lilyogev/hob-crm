// כרטיס מועמד/קשר בטאב המשפיענים: מה ליה מצאה ואימתה, הטעם של יוגב (נפרד מהשלב),
// הפנייה המוכנה להעתקה, הצעד הבא והיומן. הכל מהשדות שנוספו ב-0080; שורת הפרוספקט
// הקיימת נשארת כמו שהייתה, וזה נפתח מתחתיה.
import { useState } from "react";

const GOALS: Record<string, string> = { reach: "חשיפה", content: "תוכן לשימוש", shoot: "צילומים", sales: "מכירות בקוד" };
const SOURCE: Record<string, string> = { tagged: "תייג אותנו", rival_mention: "מוזכר אצל מותג", seed: "ביקשת לבדוק", research: "מחקר של ליה", yogev: "ממך" };

export type ProspectExtra = {
  id: number;
  status: string;
  source: string;
  checked_at: string | null;
  verified: string;
  evidence: string;
  verdict: string;
  verdict_reason: string;
  next_step: string;
  followup_date: string;
  offer: string;
  log: string;
  size: string;
  package_sent_at?: string;
  shoot?: string;
  version?: string;
};

// אישור צילום אפשרי מהשלב "ענה" ואילך. רשומה ישנה (scheduled) נפתרת כאן במפורש.
const SHOOT_FROM = ["talking", "agreed", "package_sent", "shoot_set", "scheduled"];

const parse = <T,>(t: string, fb: T): T => {
  try {
    return t ? (JSON.parse(t) as T) : fb;
  } catch {
    return fb;
  }
};
const ghost = "rounded-md border border-[var(--hob-rule)] px-2 py-0.5 text-[11.5px] text-[var(--hob-ink)] hover:bg-[var(--hob-hover)]";
const field = "rounded-md border border-[var(--hob-rule)] bg-[var(--hob-bg)] px-2 py-1 text-[12px] text-[var(--hob-ink)] outline-none";

export function ProspectCard({ p, act }: { p: ProspectExtra; act: (body: Record<string, unknown>) => void }) {
  const v = parse<{ at?: string; followers?: number; avgLikes?: number; hiddenLikes?: number; posts?: { permalink: string; caption: string; likes: number; timestamp: string }[]; lastPost?: string; error?: string }>(p.verified, {});
  const e = parse<{ why?: string; examples?: { url: string; note: string }[]; goals?: string[]; idea?: string; nextStep?: string; unknown?: string[]; outcome?: Record<string, string> }>(p.evidence, {});
  const offer = parse<{ message?: string; offer?: string; ask?: string; item?: string; size?: string; cost?: string; terms?: string[]; at?: string }>(p.offer, {});
  const log = parse<{ at: string; text: string }[]>(p.log, []);
  const [reason, setReason] = useState(p.verdict_reason);
  const [step, setStep] = useState(p.next_step);
  const [due, setDue] = useState(p.followup_date);
  const [size, setSize] = useState(p.size);
  const [note, setNote] = useState("");
  const [copied, setCopied] = useState(false);
  const [outcome, setOutcome] = useState({ content: "", metTerms: "", cost: "", reach: "", sales: "" });
  const shoot = parse<{ when?: string; where?: string; confirmed_at?: string }>(p.shoot ?? "", {});
  const [shootWhen, setShootWhen] = useState(shoot.when ?? "");
  const [shootWhere, setShootWhere] = useState(shoot.where ?? "");
  const verdictBtn = (key: string, label: string, color: string) => (
    <button type="button" onClick={() => act({ action: "prospect_verdict", id: p.id, verdict: p.verdict === key ? "" : key, reason })} className="rounded-full border px-2.5 py-0.5 text-[11.5px] font-semibold" style={p.verdict === key ? { backgroundColor: color, borderColor: color, color: "#fff" } : { borderColor: "var(--hob-rule)", color: "var(--hob-ink)" }}>
      {label}
    </button>
  );
  const verifiedLine = v.error
    ? `לא ניתן לאמת מול אינסטגרם (${/not|found|לא/i.test(v.error) ? "כנראה חשבון פרטי או שם שגוי" : v.error}). המספרים לא ידועים.`
    : v.at
      ? `${(v.followers ?? 0).toLocaleString("en-US")} עוקבים · ${(v.posts ?? []).length} פוסטים אחרונים, ${(v.hiddenLikes ?? 0) >= (v.posts ?? []).length && (v.posts ?? []).length ? "לייקים מוסתרים (לא ידוע)" : `${(v.avgLikes ?? 0).toLocaleString("en-US")} לייקים בממוצע${v.hiddenLikes ? ` (ב-${v.hiddenLikes} מוסתרים)` : ""}`} · פוסט אחרון ${v.lastPost || "?"} · נבדק ${v.at.slice(0, 10)}`
      : "לא אומת מול אינסטגרם.";
  const isDone = p.status === "done";
  return (
    <div className="mt-1 w-full rounded-md bg-[var(--hob-hover)]/60 px-3 py-2 text-[12.5px] leading-relaxed text-[var(--hob-ink)]">
      <div className="text-[11.5px] text-[var(--hob-faint)]">
        מקור: {SOURCE[p.source] ?? p.source ?? "לא ידוע"}{p.checked_at ? ` · נבדק ${p.checked_at.slice(0, 10)}` : ""} · אינסטגרם: {verifiedLine}
      </div>
      {e.why && <p className="mt-1"><b>למה מתאים:</b> {e.why}</p>}
      {e.examples?.length ? (
        <ul className="mt-1 list-disc pe-4">
          {e.examples.map((x, i) => (
            <li key={i}><a href={x.url} target="_blank" rel="noopener" className="text-[#0073ea] hover:underline">פוסט</a> · {x.note}</li>
          ))}
        </ul>
      ) : null}
      {e.goals?.length ? (
        <div className="mt-1 flex flex-wrap gap-1">
          {e.goals.map((g) => <span key={g} className="rounded-full bg-[var(--hob-bg)] px-2 py-0.5 text-[11px]">{GOALS[g] ?? g}</span>)}
        </div>
      ) : null}
      {e.idea && <p className="mt-1"><b>רעיון:</b> {e.idea}</p>}
      {e.unknown?.length ? <p className="mt-1 text-[var(--hob-faint)]"><b>לא ידוע:</b> {e.unknown.join(" · ")}</p> : null}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="text-[11.5px] text-[var(--hob-faint)]">דעתך:</span>
        {verdictBtn("fit", "מתאים", "#00a359")}
        {verdictBtn("not_fit", "לא מתאים", "#e2445c")}
        {verdictBtn("later", "בהמשך", "#676879")}
        <input value={reason} onChange={(ev) => setReason(ev.target.value)} onBlur={() => p.verdict && reason !== p.verdict_reason && act({ action: "prospect_verdict", id: p.id, verdict: p.verdict, reason })} maxLength={200} placeholder="למה? (רשות, מלמד את ליה)" className={`${field} min-w-[160px] flex-1`} />
      </div>

      {offer.message && (
        <div className="mt-2 rounded-md border border-[var(--hob-rule)] bg-[var(--hob-bg)] p-2">
          <div className="flex items-center justify-between">
            <span className="text-[11.5px] font-semibold">פנייה מוכנה (להעתקה בלבד, לא נשלחה){offer.at ? ` · ${offer.at}` : ""}</span>
            <button type="button" onClick={async () => { await navigator.clipboard.writeText(offer.message ?? ""); setCopied(true); setTimeout(() => setCopied(false), 1500); }} className={ghost}>{copied ? "הועתק ✓" : "העתק הודעה"}</button>
          </div>
          <p className="mt-1 whitespace-pre-wrap">{offer.message}</p>
          <div className="mt-1 text-[11.5px] text-[var(--hob-faint)]">
            {offer.offer && <div>מציעים: {offer.offer}</div>}
            {offer.ask && <div>מבקשים: {offer.ask}</div>}
            {(offer.item || offer.cost) && <div>פריט: {offer.item || "?"}{offer.size ? ` (${offer.size})` : ""}{offer.cost ? ` · עלות משוערת: ${offer.cost}` : ""}</div>}
            {offer.terms?.length ? <div>לסכם: {offer.terms.join(" · ")}</div> : null}
          </div>
        </div>
      )}

      {(p.package_sent_at || shoot.confirmed_at) && (
        <p className="mt-2 text-[11.5px]">
          {p.package_sent_at && <span>📦 חבילה נשלחה {p.package_sent_at.slice(0, 10)}</span>}
          {p.package_sent_at && shoot.confirmed_at && " · "}
          {shoot.confirmed_at && <span>🎬 אישר/ה צילום: מתי {shoot.when || "לא ידוע"} · איפה {shoot.where || "לא ידוע"} (סומן {shoot.confirmed_at.slice(0, 10)})</span>}
        </p>
      )}
      {p.status === "scheduled" && (
        <div className="mt-2 rounded-md border border-[#c98a00] p-2 text-[12px]">
          <div className="font-semibold text-[#c98a00]">לבירור: רשומה מהשלב הישן "חבילה / צילום"</div>
          <p className="text-[11.5px] text-[var(--hob-faint)]">השלב הישן לא הבחין בין חבילה שנשלחה לצילום שנקבע, אז זה לא נחשב צילום. מה קרה בפועל?</p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <button type="button" onClick={() => act({ action: "prospect_status", id: p.id, status: "package_sent", version: p.version ?? "" })} className={ghost}>חבילה נשלחה</button>
            <button type="button" onClick={() => act({ action: "prospect_status", id: p.id, status: "agreed", version: p.version ?? "" })} className={ghost}>עדיין לא, רק סוכמו תנאים</button>
            <span className="self-center text-[11px] text-[var(--hob-faint)]">צילום שאושר: בטופס למטה</span>
          </div>
        </div>
      )}
      {SHOOT_FROM.includes(p.status) && (
        <form
          className="mt-2 flex flex-wrap items-center gap-1.5"
          onSubmit={(ev) => {
            ev.preventDefault();
            act({ action: "prospect_status", id: p.id, shoot: { confirmed: true, when: shootWhen, where: shootWhere }, version: p.version ?? "" });
          }}
        >
          <span className="text-[11.5px] text-[var(--hob-faint)]">{shoot.confirmed_at ? "עדכון פרטי הצילום:" : "צילום:"}</span>
          <input value={shootWhen} onChange={(ev) => setShootWhen(ev.target.value)} maxLength={80} placeholder="מתי (כפי שסוכם)" className={`${field} w-32`} />
          <input value={shootWhere} onChange={(ev) => setShootWhere(ev.target.value)} maxLength={120} placeholder="איפה (רשות)" className={`${field} w-32`} />
          <button type="submit" className={ghost} title="רק כשהאדם אישר במפורש שהוא מגיע. מיכאלה מקבלת את זה כאישור השתתפות.">{shoot.confirmed_at ? "עדכן" : "אישר/ה שמגיע/ה לצילום"}</button>
        </form>
      )}
      {!isDone && p.status !== "candidate" && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <input value={step} onChange={(ev) => setStep(ev.target.value)} onBlur={() => step !== p.next_step && act({ action: "prospect_update", id: p.id, next_step: step })} maxLength={140} placeholder="הצעד הבא" className={`${field} min-w-[180px] flex-1`} />
          <input type="date" value={due} onChange={(ev) => { setDue(ev.target.value); act({ action: "prospect_update", id: p.id, followup_date: ev.target.value }); }} className={field} />
          <input value={size} onChange={(ev) => setSize(ev.target.value)} onBlur={() => size !== p.size && act({ action: "prospect_update", id: p.id, size })} maxLength={6} placeholder="מידה" className={`${field} w-16`} />
        </div>
      )}
      {!isDone && (
        <form className="mt-1.5 flex gap-1.5" onSubmit={(ev) => { ev.preventDefault(); if (note.trim()) { act({ action: "prospect_update", id: p.id, note }); setNote(""); } }}>
          <input value={note} onChange={(ev) => setNote(ev.target.value)} maxLength={400} placeholder="עדכון ליומן (מה ענה, מה סוכם)" className={`${field} flex-1`} />
          <button type="submit" className={ghost}>הוסף</button>
        </form>
      )}
      {p.status === "received" && !e.outcome && (
        <div className="mt-2 rounded-md border border-[var(--hob-rule)] p-2">
          <div className="text-[11.5px] font-semibold">סיום: מה יצא מזה (שלוש מידות נפרדות)</div>
          <div className="mt-1 grid grid-cols-1 gap-1 sm:grid-cols-2">
            <input value={outcome.content} onChange={(ev) => setOutcome({ ...outcome, content: ev.target.value })} placeholder="מה התקבל (תוכן)" className={field} />
            <input value={outcome.metTerms} onChange={(ev) => setOutcome({ ...outcome, metTerms: ev.target.value })} placeholder="עמד בסיכום?" className={field} />
            <input value={outcome.cost} onChange={(ev) => setOutcome({ ...outcome, cost: ev.target.value })} placeholder="עלות בפועל" className={field} />
            <input value={outcome.reach} onChange={(ev) => setOutcome({ ...outcome, reach: ev.target.value })} placeholder="חשיפה (אם ידוע)" className={field} />
            <input value={outcome.sales} onChange={(ev) => setOutcome({ ...outcome, sales: ev.target.value })} placeholder="מכירות בקוד (אם ידוע)" className={field} />
          </div>
          <button type="button" onClick={() => act({ action: "prospect_outcome", id: p.id, outcome })} className={`${ghost} mt-1.5`}>שמור וסמן הושלם</button>
        </div>
      )}
      {e.outcome && (
        <p className="mt-2 text-[11.5px] text-[var(--hob-faint)]">
          תוצאה ({e.outcome.at}): תוכן: {e.outcome.content || "?"} · עמד בסיכום: {e.outcome.metTerms || "?"} · עלות: {e.outcome.cost || "?"} · חשיפה: {e.outcome.reach || "לא נמדד"} · מכירות: {e.outcome.sales || "לא נמדד"}
        </p>
      )}
      {log.length > 0 && (
        <details className="mt-1.5">
          <summary className="cursor-pointer text-[11.5px] text-[var(--hob-faint)]">יומן ({log.length})</summary>
          <ul className="mt-1 text-[11.5px] text-[var(--hob-soft)]">
            {log.slice().reverse().map((l, i) => <li key={i}>{l.at.slice(0, 10)}: {l.text}</li>)}
          </ul>
        </details>
      )}
    </div>
  );
}
