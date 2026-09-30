// הטאב "הובי": הצ'אט עם העוזרת בתוך הלוח. מסך מלא בטלפון, כרטיס ממורכז במחשב.
// סקירה כל 12 שניות (הודעות של השותפה השנייה מופיעות לבד), 📷 לקבלה, מיקרופון
// לתמלול, וכרטיסי "מחכה לאישור" לפקודות קוליות שמשנות כסף, מלאי או משלוח.
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { isPartner, PARTNER, partnerLabel } from "../../lib/partners";
import { toast } from "./toast";
import { useRecorder } from "./use-recorder";

type ChatMessage = { id: number; role: string; content: string; kind: string; actor: string; created_at: string };
type Held = { id: number; summary: string; state: "pending" | "unknown"; note?: string };
type Thread = { me: string; messages: ChatMessage[]; pending: Held[] };

async function fetchThread(): Promise<Thread> {
  const res = await fetch("/api/assistant/chat");
  if (res.status === 401) throw new Error("unauthorized");
  if (!res.ok) throw new Error(`http ${res.status}`);
  const data = (await res.json()) as { me?: string; messages?: ChatMessage[]; pending?: Held[] };
  return { me: data.me ?? "", messages: data.messages ?? [], pending: data.pending ?? [] };
}

// ---- אישורים: כרטיס יורד מהמסך רק כשהשרת אישר מצב סופי. בקשה שנפלה לא מורידה
// אותו, ולפני ניסיון נוסף שואלים את השרת מה קרה.
const FINAL = new Set(["done", "cancelled", "expired", "failed", "closed", "not_found"]);
const NOTE: Record<string, string> = {
  in_progress: "הפעולה בביצוע עכשיו. לא שלחתי שוב.",
  executing: "הפעולה בביצוע עכשיו. לא שלחתי שוב.",
  unknown: "הביצוע נקטע באמצע ולא ידוע אם נרשם. בדקו ביומן לפני בקשה חוזרת.",
  pending: "הבקשה לא הגיעה לשרת והפעולה לא בוצעה. אפשר ללחוץ שוב.",
};

async function resolveConfirm(id: number, approve: boolean): Promise<{ remove: boolean; toast: string; note?: string; state?: Held["state"] }> {
  let reply: { ok: boolean; status: string; text: string } | null = null;
  try {
    const res = await fetch("/api/assistant/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: id, approve }) });
    if (res.status === 401) throw new Error("unauthorized");
    reply = res.ok ? ((await res.json()) as { ok: boolean; status: string; text: string }) : null;
  } catch (error) {
    if ((error as Error).message === "unauthorized") throw error;
    reply = null;
  }
  let status = reply?.status ?? "";
  let text = reply?.text ?? "";
  if (!reply || !status || status === "error") {
    try {
      const res = await fetch(`/api/assistant/chat?pending_id=${id}`);
      const now = res.ok ? ((await res.json()) as { pending_status: { status: string; text: string } | null }).pending_status : null;
      status = now?.status ?? "";
      text = now?.text ?? text;
    } catch {
      status = "";
    }
    if (!status) return { remove: false, toast: "אין תשובה מהשרת. הכרטיס נשאר, ולא ידוע אם הפעולה בוצעה.", note: "אין חיבור לשרת. לא ידוע אם בוצע." };
  }
  if (FINAL.has(status)) {
    const msg = status === "done" ? text || "בוצע" : status === "cancelled" ? "בוטל, לא בוצע כלום" : status === "expired" ? "פג תוקף האישור. אמרו שוב את הפקודה." : status === "failed" ? text || "הפעולה נכשלה ולא בוצעה" : status === "not_found" ? "הפעולה לא נמצאה. כלום לא בוצע." : "נסגר";
    return { remove: true, toast: msg };
  }
  return { remove: false, toast: NOTE[status] ?? "הפעולה עוד לא הושלמה", note: NOTE[status] ?? "", state: status === "unknown" ? "unknown" : "pending" };
}

/** תור של שותפה נשמר כ"אביה: טקסט"; מפרידים את השם חזרה. */
function splitSpeaker(content: string): { speaker: string; text: string } {
  const m = /^([^:\n]{1,20}): ([\s\S]*)$/.exec(content);
  return m ? { speaker: m[1], text: m[2] } : { speaker: "", text: content };
}

/** תמונות מהטלפון מגיעות ב-4-8MB; מקטינים ל-1600px JPEG לפני ההעלאה. */
async function shrinkImage(file: File): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    return blob ?? file;
  } catch {
    return file;
  }
}

function timeLabel(createdAt: string): string {
  const d = new Date(`${createdAt.replace(" ", "T")}Z`);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });
}

function dayLabel(createdAt: string): string {
  const d = new Date(`${createdAt.replace(" ", "T")}Z`);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("he-IL", { day: "numeric", month: "numeric" });
}

// **מודגש** מהמודל מוצג מודגש; "# כותרת" הופכת לשורה מודגשת.
function renderBold(raw: string) {
  const text = raw.replace(/^#{1,4}\s+(.+)$/gm, "**$1**");
  return text.split(/(\*\*[^*\n]+\*\*)/g).map((part, i) => (part.startsWith("**") && part.endsWith("**") && part.length > 4 ? <strong key={i}>{part.slice(2, -2)}</strong> : part));
}

/** הודעה ארוכה מתקפלת אחרי כ-9 שורות עם "הצג הכל"; האחרונה תמיד פתוחה. */
export function LongText({ text, startOpen = false, user = false }: { text: string; startOpen?: boolean; user?: boolean }) {
  const long = text.length > 520 || text.split("\n").length > 9;
  const [open, setOpen] = useState(startOpen || !long);
  return (
    <div className={user ? "" : "text-[var(--hob-ink)]"}>
      <div className={open ? "" : "relative max-h-[9.5em] overflow-hidden"}>
        {renderBold(text)}
        {!open && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-[var(--hob-bg)] to-transparent" />}
      </div>
      {long && (
        <button type="button" onClick={() => setOpen((v) => !v)} className="mt-1 text-xs font-medium text-[var(--hob-accent)]">
          {open ? "הצג פחות" : "הצג הכל"}
        </button>
      )}
    </div>
  );
}

/** האווטאר של הובי: עיגול "h" בצבע ההדגשה. */
function HobiAvatar({ size = 36 }: { size?: number }) {
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center rounded-full bg-[var(--hob-accent)] font-semibold lowercase text-[var(--hob-accent-fg)]"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.55), fontFamily: "var(--hob-mono)" }}
    >
      h
    </span>
  );
}

export function AssistantChatView({
  actor,
  onAuthLost,
  onSeen,
  embedded,
  onClose,
}: {
  /** מי שמחוברת ('avia' | 'lior'), לצביעת הבועות בלבד. השרת קובע את הכותבת מהסשן. */
  actor: string;
  onAuthLost: () => void;
  /** מזהה ההודעה הגבוה ביותר שמוצג, לניקוי התג על הטאב. */
  onSeen?: (maxId: number) => void;
  /** בתוך המעטפת של הלוח: מסך מלא בטלפון, כרטיס במחשב. */
  embedded?: boolean;
  /** כפתור חזרה בכותרת (בטלפון, כשהצ'אט מכסה את הניווט). */
  onClose?: () => void;
}) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["hobi-chat"],
    queryFn: fetchThread,
    refetchInterval: 12_000,
    refetchOnWindowFocus: true,
    retry: (count, error) => error.message !== "unauthorized" && count < 2,
  });
  useEffect(() => {
    if (query.error?.message === "unauthorized") onAuthLost();
  }, [query.error, onAuthLost]);

  const me = query.data?.me || actor;
  const [draft, setDraft] = useState("");
  const [notes, setNotes] = useState<Record<number, string>>({});
  // בועה זמנית להודעה בדרך: הובי לוקחת 10-30 שניות כשהיא משתמשת בכלים.
  const [pending, setPending] = useState<string | null>(null);
  // התשובה המיידית של התור שרץ עכשיו (בועה זמנית, לא נשמרת בשרשור).
  const [quick, setQuick] = useState<string | null>(null);
  const [sendError, setSendError] = useState(false);
  const [voiceError, setVoiceError] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const messages = query.data?.messages ?? [];

  // עוקבים אחרי השיחה רק כשהקוראת כבר למטה או שלחה משהו.
  const stickToBottom = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (pending || stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, pending, quick]);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const maxId = messages.length ? messages[messages.length - 1].id : 0;
  useEffect(() => {
    if (maxId > 0) onSeen?.(maxId);
  }, [maxId, onSeen]);

  const held: Held[] = (query.data?.pending ?? []).map((h) => ({ ...h, note: notes[h.id] ?? h.note }));
  const [confirming, setConfirming] = useState(false);
  async function answerHeld(id: number, approve: boolean) {
    if (confirming) return;
    setConfirming(true);
    try {
      const out = await resolveConfirm(id, approve);
      toast(out.toast, out.remove ? "ok" : "error");
      setNotes((cur) => ({ ...cur, [id]: out.remove ? "" : (out.note ?? "") }));
      await queryClient.invalidateQueries({ queryKey: ["hobi-chat"] });
    } catch (error) {
      if ((error as Error).message === "unauthorized") onAuthLost();
    } finally {
      setConfirming(false);
    }
  }
  async function closeUnknown(id: number) {
    await fetch("/api/assistant/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ close_unknown: id }) });
    await queryClient.invalidateQueries({ queryKey: ["hobi-chat"] });
  }

  // קול: הקלטה במכשיר, תמלול בשרת, ושליחה עם voice:true (פעולות על כסף/מלאי/משלוח מחכות לאישור).
  const rec = useRecorder(
    (text) => void send(text),
    (message) => (message === "unauthorized" ? onAuthLost() : setVoiceError(message)),
  );

  async function send(spoken?: string) {
    const text = (spoken ?? draft).trim();
    if (!text || pending !== null) return;
    setDraft("");
    setSendError(false);
    setVoiceError("");
    setPending(text);
    const turn = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `t-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    let polling = true;
    const poll = async () => {
      while (polling) {
        await new Promise((r) => setTimeout(r, 700));
        if (!polling) break;
        try {
          const r = await fetch(`/api/assistant/chat?live_turn=${turn}`);
          if (!r.ok) continue;
          const out = (await r.json()) as { quick?: { text: string } | null };
          if (polling && out.quick?.text) setQuick(out.quick.text);
        } catch {
          // display only
        }
      }
    };
    void poll();
    try {
      const res = await fetch("/api/assistant/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, voice: Boolean(spoken), turn }),
      });
      polling = false;
      if (res.status === 401) {
        onAuthLost();
        return;
      }
      if (!res.ok) throw new Error(`http ${res.status}`);
      await queryClient.invalidateQueries({ queryKey: ["hobi-chat"] });
    } catch {
      setSendError(true);
      setDraft(text);
    } finally {
      polling = false;
      setQuick(null);
      setPending(null);
    }
  }

  async function sendReceipt(file: File) {
    if (pending !== null) return;
    setSendError(false);
    setPending("📎 קבלה נשלחת, הובי קוראת אותה…");
    try {
      const blob = await shrinkImage(file);
      const res = await fetch("/api/assistant/chat", { method: "POST", headers: { "content-type": blob.type || "image/jpeg" }, body: blob });
      if (res.status === 401) {
        onAuthLost();
        return;
      }
      if (!res.ok) throw new Error(`http ${res.status}`);
      await queryClient.invalidateQueries({ queryKey: ["hobi-chat"] });
    } catch {
      setSendError(true);
    } finally {
      setPending(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const colorOf = (key: string) => (isPartner(key) ? PARTNER[key].color : "var(--hob-soft)");
  const myLabel = partnerLabel(me) || "שותפה";
  let lastDay = "";
  const lastId = messages.length ? messages[messages.length - 1].id : -1;

  return (
    <div
      className={
        embedded
          ? "fixed inset-0 z-[60] flex flex-col bg-[var(--hob-surface)] pt-[env(safe-area-inset-top)] sm:static sm:z-auto sm:mx-auto sm:h-[calc(100dvh-150px)] sm:min-h-[420px] sm:max-w-3xl sm:overflow-hidden sm:rounded-2xl sm:border sm:border-[var(--hob-rule)] sm:pt-0 sm:shadow-sm"
          : "mx-auto flex h-[calc(100dvh-190px)] min-h-[420px] max-w-3xl flex-col overflow-hidden rounded-2xl border border-[var(--hob-rule)] bg-[var(--hob-surface)] shadow-sm"
      }
    >
      <div className="flex items-center gap-2.5 border-b border-[var(--hob-rule)] px-3.5 py-2.5">
        <HobiAvatar />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-[var(--hob-ink)]">הובי</div>
          <div className="text-[11px] text-[var(--hob-faint)]">העוזרת הדיגיטלית של hob</div>
        </div>
        {onClose && (
          <button type="button" onClick={onClose} className="rounded-lg border border-[var(--hob-rule-strong)] px-3 py-1.5 text-xs text-[var(--hob-ink)] hover:bg-[var(--hob-hover)] sm:hidden">
            חזרה ללוח
          </button>
        )}
      </div>
      <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto px-3 py-4 sm:px-5">
        {query.isLoading && <div className="py-16 text-center text-[var(--hob-faint)]">טוענת את השיחה…</div>}
        {!query.isLoading && messages.length === 0 && !pending && (
          <div className="py-16 text-center text-[var(--hob-faint)]">
            <div className="mb-3 flex justify-center">
              <HobiAvatar size={48} />
            </div>
            היי, אני הובי, העוזרת הדיגיטלית של hob.
            <br />
            אפשר לרשום מכירות והוצאות, לשאול על מלאי ומשימות, ולצלם קבלה.
          </div>
        )}
        {messages.map((m) => {
          const isUser = m.role === "user";
          const isNote = m.kind === "note";
          const { speaker, text } = isUser ? splitSpeaker(m.content) : { speaker: "הובי", text: m.content };
          const day = dayLabel(m.created_at);
          const showDay = day !== lastDay;
          lastDay = day;
          const mine = isUser && me !== "" && m.actor === me;
          return (
            <div key={m.id}>
              {showDay && (
                <div className="my-3 text-center">
                  <span className="rounded-full bg-[var(--hob-hover)] px-3 py-0.5 text-xs text-[var(--hob-soft)]">{day}</span>
                </div>
              )}
              <div dir="rtl" className={`mb-2.5 flex ${isUser ? "justify-end" : "justify-start"}`}>
                <div
                  className={`whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-start text-sm leading-relaxed ${
                    isUser
                      ? `max-w-[85%] border sm:max-w-[70%] ${mine ? "border-transparent bg-[var(--hob-bg2)]" : "border-[var(--hob-rule)] bg-[var(--hob-bg)]"} text-[var(--hob-ink)]`
                      : isNote
                        ? "w-full max-w-[94%] border border-dashed border-[var(--hob-rule-strong)] bg-[var(--hob-bg)] sm:max-w-[82%]"
                        : "w-full max-w-[94%] border border-[var(--hob-rule)] bg-[var(--hob-bg)] sm:max-w-[82%]"
                  }`}
                >
                  <div className="mb-0.5 text-xs font-bold" style={{ color: isUser ? colorOf(m.actor) : "var(--hob-soft)" }}>
                    {isUser ? speaker || partnerLabel(m.actor) || "שותפה" : isNote ? "עדכון מהלוח" : "הובי"}
                  </div>
                  <LongText text={text} startOpen={m.id === lastId} user={isUser} />
                  <div className="mt-1 text-end text-[10px] text-[var(--hob-faint)]">{timeLabel(m.created_at)}</div>
                </div>
              </div>
            </div>
          );
        })}
        {pending !== null && (
          <>
            <div dir="rtl" className="mb-2 flex justify-end">
              <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-[var(--hob-bg2)] px-3.5 py-2 text-start text-sm leading-relaxed shadow-sm sm:max-w-[75%]">
                <div className="mb-0.5 text-xs font-bold" style={{ color: colorOf(me) }}>
                  {myLabel}
                </div>
                <div className="text-[var(--hob-ink)]">{pending}</div>
              </div>
            </div>
            <div dir="rtl" className="mb-2 flex justify-start">
              <div className="w-full max-w-[94%] whitespace-pre-wrap rounded-2xl bg-[var(--hob-bg2)] px-3.5 py-2 text-start text-sm leading-relaxed text-[var(--hob-soft)] shadow-sm sm:max-w-[82%]">
                <div className="mb-0.5 text-xs font-bold text-[var(--hob-faint)]">הובי</div>
                {quick ? (
                  <>
                    <div>{quick}</div>
                    <div className="mt-1 text-[10px] text-[var(--hob-faint)]">
                      בודקת לעומק<span className="animate-pulse">…</span>
                    </div>
                  </>
                ) : (
                  <div>
                    הובי חושבת<span className="animate-pulse">…</span>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
        {sendError && <div className="mb-2 text-center text-xs text-[#e2445c]">ההודעה לא נשלחה. נסו שוב.</div>}
      </div>
      {held.map((h) => (
        <div key={h.id} className="mx-3 mb-2 rounded-xl border border-[#fdab3d] bg-[var(--hob-bg)] p-3">
          <div className="text-xs font-medium text-[#fdab3d]">{h.state === "unknown" ? "לא ידוע אם בוצע" : "מחכה לאישור, עוד לא בוצע"}</div>
          <div className="mt-1 text-sm leading-relaxed text-[var(--hob-ink)]">{h.summary}</div>
          {h.note && <div className="mt-1 text-xs text-[#f0768a]">{h.note}</div>}
          <div className="mt-2 flex gap-2">
            {h.state === "unknown" ? (
              <button type="button" onClick={() => void closeUnknown(h.id)} className="rounded-lg border border-[var(--hob-rule-strong)] px-4 py-1.5 text-sm text-[var(--hob-ink)]">
                בדקתי ביומן, סגרי
              </button>
            ) : (
              <>
                <button type="button" disabled={confirming} onClick={() => void answerHeld(h.id, true)} className="rounded-lg bg-[var(--hob-accent)] px-4 py-1.5 text-sm font-medium text-[var(--hob-accent-fg)] disabled:opacity-50">
                  אשרי ובצעי
                </button>
                <button type="button" disabled={confirming} onClick={() => void answerHeld(h.id, false)} className="rounded-lg border border-[var(--hob-rule-strong)] px-4 py-1.5 text-sm text-[var(--hob-ink)] disabled:opacity-50">
                  בטלי
                </button>
              </>
            )}
          </div>
        </div>
      ))}
      {voiceError && <div className="px-3 pb-1 text-center text-xs text-[#e2445c]">{voiceError}</div>}
      <div className={`flex items-end gap-1.5 border-t border-[var(--hob-rule)] p-2.5 sm:gap-2 sm:p-3 ${embedded ? "pb-[max(0.625rem,env(safe-area-inset-bottom))]" : ""}`}>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void sendReceipt(f);
          }}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={pending !== null}
          title="צילום קבלה: נרשמת כהוצאה ומצורפת אליה"
          className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-xl border border-[var(--hob-rule-strong)] bg-[var(--hob-surface)] text-lg transition-opacity disabled:opacity-40"
        >
          📷
        </button>
        {rec.supported && (
          <button
            type="button"
            onClick={() => void rec.toggle()}
            disabled={pending !== null || rec.busy}
            title={rec.recording ? "מקליטה. לחיצה עוצרת ושולחת" : "לדבר עם הובי"}
            aria-pressed={rec.recording}
            className={`flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-xl border text-lg transition disabled:opacity-40 ${
              rec.recording ? "animate-pulse border-[#e2445c] bg-[#e2445c] text-white" : "border-[var(--hob-rule-strong)] bg-[var(--hob-surface)]"
            }`}
          >
            🎙️
          </button>
        )}
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          rows={1}
          placeholder={rec.recording ? "מקליטה… לחיצה נוספת שולחת" : rec.busy ? "מתמללת…" : "כתבו להובי…"}
          className="max-h-32 min-h-[42px] min-w-0 flex-1 resize-none rounded-xl border border-[var(--hob-rule-strong)] bg-[var(--hob-surface)] px-3.5 py-2.5 text-[16px] text-[var(--hob-ink)] outline-none focus:border-[var(--hob-accent)] sm:text-sm"
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={pending !== null || !draft.trim()}
          aria-label="שליחה"
          className="h-[42px] shrink-0 rounded-xl bg-[var(--hob-accent)] px-3.5 text-sm font-medium text-[var(--hob-accent-fg)] transition-opacity disabled:opacity-40 sm:px-4"
        >
          <span className="sm:hidden">➤</span>
          <span className="hidden sm:inline">שליחה</span>
        </button>
      </div>
    </div>
  );
}
