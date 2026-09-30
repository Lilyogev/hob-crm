// The open card under an outreach row: the next step and its date, the size
// she asked for, the personal line for her invite page, editable details,
// and a free-text log ("ענתה, רוצה את הסט הכחול"). Everything is typed by the
// partners — nothing here is verified or generated.
import { useState } from "react";

export type ProspectExtra = {
  id: number;
  status: string;
  name: string;
  instagram: string;
  followers: number;
  gender: string;
  niche: string;
  note: string;
  personal: string;
  next_step: string;
  followup_date: string;
  size: string;
  log: string;
};

const parse = <T,>(t: string, fb: T): T => {
  try {
    return t ? (JSON.parse(t) as T) : fb;
  } catch {
    return fb;
  }
};
const ghost =
  "rounded-md border border-[var(--hob-rule)] px-2 py-0.5 text-[11.5px] text-[var(--hob-ink)] hover:bg-[var(--hob-hover)]";
const field =
  "rounded-md border border-[var(--hob-rule)] bg-[var(--hob-bg)] px-2 py-1 text-[12px] text-[var(--hob-ink)] outline-none";

export function ProspectCard({ p, act }: { p: ProspectExtra; act: (body: Record<string, unknown>) => void }) {
  const log = parse<{ at: string; text: string }[]>(p.log, []);
  const [step, setStep] = useState(p.next_step);
  const [due, setDue] = useState(p.followup_date);
  const [size, setSize] = useState(p.size);
  const [personal, setPersonal] = useState(p.personal);
  const [niche, setNiche] = useState(p.niche);
  const [note, setNote] = useState(p.note);
  const [followers, setFollowers] = useState(p.followers ? String(p.followers) : "");
  const [entry, setEntry] = useState("");
  const isDone = p.status === "done" || p.status === "rejected";
  const update = (body: Record<string, unknown>) => act({ action: "update_prospect", id: p.id, ...body });

  return (
    <div className="mt-1 w-full rounded-md bg-[var(--hob-hover)]/60 px-3 py-2 text-[12.5px] leading-relaxed text-[var(--hob-ink)]">
      {/* Next step, follow-up date, size */}
      {!isDone && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11.5px] text-[var(--hob-faint)]">הצעד הבא:</span>
          <input
            value={step}
            onChange={(ev) => setStep(ev.target.value)}
            onBlur={() => step !== p.next_step && update({ next_step: step })}
            maxLength={140}
            placeholder="מה עושות עכשיו (לשלוח הודעה, לחכות לתשובה)"
            className={`${field} min-w-[180px] flex-1`}
          />
          <input
            type="date"
            value={due}
            title="תאריך מעקב"
            onChange={(ev) => {
              setDue(ev.target.value);
              update({ followup_date: ev.target.value });
            }}
            className={field}
          />
          <input
            value={size}
            onChange={(ev) => setSize(ev.target.value)}
            onBlur={() => size !== p.size && update({ size })}
            maxLength={6}
            placeholder="מידה"
            className={`${field} w-16`}
          />
        </div>
      )}

      {/* Details the row shows in short */}
      <div className="mt-1.5 grid grid-cols-1 gap-1.5 sm:grid-cols-3">
        <input
          value={followers}
          onChange={(ev) => setFollowers(ev.target.value)}
          onBlur={() => {
            const n = Number(followers.replace(/[^\d]/g, "")) || 0;
            if (n !== p.followers) update({ followers: n });
          }}
          inputMode="numeric"
          placeholder="עוקבים"
          className={field}
        />
        <input
          value={niche}
          onChange={(ev) => setNiche(ev.target.value)}
          onBlur={() => niche !== p.niche && update({ niche })}
          maxLength={60}
          placeholder="נישה"
          className={field}
        />
        <select value={p.gender} onChange={(ev) => update({ gender: ev.target.value })} className={field} title="קובע את הפנייה בעמוד האישי">
          <option value="">פנייה נייטרלית</option>
          <option value="f">בחורה</option>
          <option value="m">בחור</option>
        </select>
      </div>
      <input
        value={note}
        onChange={(ev) => setNote(ev.target.value)}
        onBlur={() => note !== p.note && update({ note })}
        maxLength={300}
        placeholder="הערה (למה היא מתאימה, איפה ראינו אותה)"
        className={`${field} mt-1.5 w-full`}
      />
      <input
        value={personal}
        onChange={(ev) => setPersonal(ev.target.value)}
        onBlur={() => personal !== p.personal && update({ personal })}
        maxLength={200}
        placeholder="✍️ שורה אישית שתופיע על העמוד שלה כשניצור לינק"
        className={`${field} mt-1.5 w-full`}
      />

      {/* Log */}
      {!isDone && (
        <form
          className="mt-1.5 flex gap-1.5"
          onSubmit={(ev) => {
            ev.preventDefault();
            if (entry.trim()) {
              act({ action: "prospect_log", id: p.id, text: entry });
              setEntry("");
            }
          }}
        >
          <input
            value={entry}
            onChange={(ev) => setEntry(ev.target.value)}
            maxLength={400}
            placeholder="עדכון ליומן (מה ענתה, מה סוכם)"
            className={`${field} flex-1`}
          />
          <button type="submit" className={ghost}>
            הוספה
          </button>
        </form>
      )}
      {log.length > 0 && (
        <details className="mt-1.5" open={log.length <= 3}>
          <summary className="cursor-pointer text-[11.5px] text-[var(--hob-faint)]">יומן ({log.length})</summary>
          <ul className="mt-1 text-[11.5px] text-[var(--hob-soft)]">
            {log
              .slice()
              .reverse()
              .map((l, i) => (
                <li key={i}>
                  {l.at.slice(8, 10)}/{l.at.slice(5, 7)}: {l.text}
                </li>
              ))}
          </ul>
        </details>
      )}
    </div>
  );
}
