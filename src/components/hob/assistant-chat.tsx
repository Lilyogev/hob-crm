// 🤖 The Bruno tab: chat with the assistant inside the board itself. Born the
// day Telegram banned the Segula community (Aug 19, 2026) — same brain and
// history table, but the only door is the board's authed session: no bot
// username, no webhook, nothing a stranger can find or report.
import { useEffect, useRef, useState } from "react";

import { type ConfirmTransport, type Held, resolveConfirm } from "./held-logic";
import { toast } from "./toast";
import { useQuery, useQueryClient } from "@tanstack/react-query";

type ChatMessage = { id: number; role: string; content: string; created_at: string };

type Thread = { messages: ChatMessage[]; pending: Held[] };

async function fetchThread(): Promise<Thread> {
  const res = await fetch("/api/assistant/chat");
  if (res.status === 401) throw new Error("unauthorized");
  if (!res.ok) throw new Error(`http ${res.status}`);
  const data = (await res.json()) as { messages?: ChatMessage[]; pending?: Held[] };
  return { messages: data.messages ?? [], pending: data.pending ?? [] };
}

export const confirmTransport: ConfirmTransport = {
  confirm: async (id, approve, edits) => {
    const res = await fetch("/api/assistant/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: id, approve, ...(edits ? { edits } : {}) }) });
    if (res.status === 401) throw new Error("unauthorized");
    if (!res.ok) throw new Error(`http ${res.status}`);
    return (await res.json()) as { ok: boolean; status: string; text: string };
  },
  status: async (id) => {
    const res = await fetch(`/api/assistant/chat?pending_id=${id}`);
    if (!res.ok) throw new Error(`http ${res.status}`);
    return ((await res.json()) as { pending_status: { status: string; text: string } | null }).pending_status;
  },
};

/** User turns are stored as "יוגב: text" — split the speaker back out. */
function splitSpeaker(content: string): { speaker: string; text: string } {
  const m = /^(יוגב|דימה|שותף): ([\s\S]*)$/.exec(content);
  return m ? { speaker: m[1], text: m[2] } : { speaker: "", text: content };
}

/**
 * Phone photos arrive at 4-8MB; the vision API caps an image at ~5MB and R2
 * shouldn't hoard originals anyway. Downscale to max 1600px JPEG before
 * upload. Falls back to the original file when decoding fails (e.g. HEIC on
 * an old browser) — the server rejects anything over 6MB with a clear error.
 */
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
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.85),
    );
    return blob ?? file;
  } catch {
    return file;
  }
}

function timeLabel(createdAt: string): string {
  // D1 stores UTC "YYYY-MM-DD HH:MM:SS" — render in the viewer's local time.
  const d = new Date(createdAt.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });
}

function dayLabel(createdAt: string): string {
  const d = new Date(createdAt.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("he-IL", { day: "numeric", month: "numeric" });
}

// Bruno answers with **bold** markers; show them as bold instead of asterisks.
function renderBold(raw: string) {
  // "# כותרת" / "## כותרת" מהמודל הופכות לשורה מודגשת בלי הסולמית.
  const text = raw.replace(/^#{1,4}\s+(.+)$/gm, "**$1**");
  return text.split(/(\*\*[^*\n]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") && part.length > 4 ? <strong key={i}>{part.slice(2, -2)}</strong> : part,
  );
}

// Bruno's briefs run long (stock lists, stuck orders). Past ~9 lines an older
// message folds to a preview with "הצג הכל", so the thread reads as a chat and
// not as a wall; the newest message always opens in full.
export function LongText({ text, startOpen = false, user = false, compact = false }: { text: string; startOpen?: boolean; user?: boolean; compact?: boolean }) {
  // compact (דוחות של עובדים): מקופל כבר אחרי כ-4 שורות, כדי שהמסך לא יהיה קיר טקסט.
  const long = compact ? text.length > 220 || text.split("\n").length > 4 : text.length > 520 || text.split("\n").length > 9;
  const [open, setOpen] = useState(startOpen || !long);
  return (
    <div className={user ? "" : "text-[var(--hob-ink)]"}>
      <div className={open ? "" : `relative ${compact ? "max-h-[5.2em]" : "max-h-[9.5em]"} overflow-hidden`}>
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

export function AssistantChatView({
  actor,
  onAuthLost,
  onSeen,
  embedded,
  onClose,
}: {
  actor: string;
  onAuthLost: () => void;
  /** Reports the highest message id on screen — clears the nav unread badge. */
  onSeen?: (maxId: number) => void;
  /** Embedded under the team tree (the unified ברונו tab): shorter panel. */
  embedded?: boolean;
  /** Embedded only: the "back to the team" button in the chat header. */
  onClose?: () => void;
}) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["bruno-chat"],
    queryFn: fetchThread,
    refetchInterval: 12_000, // the other partner's messages appear like on the board
    refetchOnWindowFocus: true,
    retry: (count, error) => error.message !== "unauthorized" && count < 2,
  });
  useEffect(() => {
    if (query.error?.message === "unauthorized") onAuthLost();
  }, [query.error, onAuthLost]);

  const [draft, setDraft] = useState("");
  const [notes, setNotes] = useState<Record<number, string>>({});
  // Optimistic bubbles for a message in flight: Bruno can take 10-30s when he
  // uses tools, and a silent wait reads as a crash (learned that the hard way).
  const [pending, setPending] = useState<string | null>(null);
  // התשובה המיידית של התור שרץ עכשיו (בועה זמנית, לא נשמרת בשרשור).
  const [quick, setQuick] = useState<string | null>(null);
  const [sendError, setSendError] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const messages = query.data?.messages ?? [];

  // Follow the conversation only when the reader is already at (or near)
  // the bottom, or just sent something. A poll landing while someone reads
  // last week's brief used to yank them down every 12 seconds — and
  // scrollIntoView scrolled the whole page along with it.
  const stickToBottom = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (pending || stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, pending]);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  // Everything rendered = everything seen; clears the nav badge.
  const maxId = messages.length ? messages[messages.length - 1].id : 0;
  useEffect(() => {
    if (maxId > 0) onSeen?.(maxId);
  }, [maxId, onSeen]);

  // ---- קול: מיקרופון (זיהוי הדיבור של הדפדפן, עברית, בלי עלות) + הקראה של
  // התשובה. בשביל לדבר עם ברונו כשהידיים תפוסות (אריזה, נהיגה). דפדפן בלי
  // תמיכה פשוט לא מציג את הכפתור.
  // פעולות שמחכות לאישור אחרי פקודה קולית: מוצג בדיוק מה ייעשה, ורק "אשר" מבצע.
  // הרשימה מגיעה מהשרת עם השרשור (שורדת רענון ומכשיר אחר). notes = הערה מקומית
  // לכרטיס שניסיון האישור שלו לא הושלם.
  const held: Held[] = (query.data?.pending ?? []).map((h) => ({ ...h, note: notes[h.id] ?? h.note }));
  const [confirming, setConfirming] = useState(false);
  async function answerHeld(id: number, approve: boolean) {
    if (confirming) return; // לחיצה כפולה לא שולחת פעמיים (והשרת ממילא מבצע פעם אחת)
    setConfirming(true);
    try {
      const out = await resolveConfirm(confirmTransport, id, approve);
      toast(out.toast);
      setNotes((cur) => ({ ...cur, [id]: out.remove ? "" : (out.card?.note ?? "") }));
      await queryClient.invalidateQueries({ queryKey: ["bruno-chat"] });
    } finally {
      setConfirming(false);
    }
  }
  async function closeUnknown(id: number) {
    await fetch("/api/assistant/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ close_unknown: id }) });
    await queryClient.invalidateQueries({ queryKey: ["bruno-chat"] });
  }
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const stopTimer = useRef<number | null>(null);
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [voiceOk, setVoiceOk] = useState(false);
  const [voiceError, setVoiceError] = useState("");
  const [speakOn, setSpeakOn] = useState(false);
  const speakRef = useRef(false);
  useEffect(() => {
    setVoiceOk(typeof MediaRecorder !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia));
    try {
      const on = localStorage.getItem("hob_bruno_speak") === "1";
      setSpeakOn(on);
      speakRef.current = on;
    } catch {
      /* private mode */
    }
    return () => {
      if (recRef.current && recRef.current.state !== "inactive") recRef.current.stop();
      window.speechSynthesis?.cancel();
    };
  }, []);
  function speak(text: string) {
    if (!("speechSynthesis" in window)) return;
    const clean = text.replace(/\*\*/g, "").replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "").replace(/#\d+/g, "").slice(0, 900);
    const u = new SpeechSynthesisUtterance(clean);
    u.lang = "he-IL";
    const he = window.speechSynthesis.getVoices().find((v) => v.lang.startsWith("he"));
    if (he) u.voice = he;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  }
  function toggleSpeak() {
    const next = !speakOn;
    setSpeakOn(next);
    speakRef.current = next;
    if (!next) window.speechSynthesis?.cancel();
    try {
      localStorage.setItem("hob_bruno_speak", next ? "1" : "0");
    } catch {
      /* private mode */
    }
  }
  // הקלטה במכשיר (MediaRecorder) ותמלול בשרת (Whisper). לחיצה מתחילה, לחיצה
  // שנייה עוצרת, מתמללת ושולחת. עוצר לבד אחרי 60 שניות.
  async function toggleMic() {
    if (listening) {
      recRef.current?.stop();
      return;
    }
    setVoiceError("");
    window.speechSynthesis?.cancel();
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setVoiceError("אין גישה למיקרופון. אשר אותה בהגדרות הדפדפן של המכשיר.");
      return;
    }
    const mime = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"].find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    chunksRef.current = [];
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    rec.onstop = async () => {
      if (stopTimer.current) window.clearTimeout(stopTimer.current);
      stream.getTracks().forEach((t) => t.stop());
      setListening(false);
      const blob = new Blob(chunksRef.current, { type: rec.mimeType || mime || "audio/mp4" });
      if (blob.size < 1500) return;
      setTranscribing(true);
      try {
        const res = await fetch("/api/transcribe", { method: "POST", headers: { "content-type": blob.type }, body: blob });
        if (res.status === 401) return onAuthLost();
        const data = (await res.json().catch(() => null)) as { ok?: boolean; text?: string } | null;
        const said = (data?.text ?? "").trim();
        if (!res.ok || !said) setVoiceError("לא הצלחתי להבין את ההקלטה. נסה שוב, קרוב יותר למיקרופון.");
        else await send(said);
      } catch {
        setVoiceError("התמלול נכשל. בדוק חיבור ונסה שוב.");
      } finally {
        setTranscribing(false);
      }
    };
    recRef.current = rec;
    rec.start();
    setListening(true);
    stopTimer.current = window.setTimeout(() => rec.state !== "inactive" && rec.stop(), 60_000);
  }

  async function send(spoken?: string) {
    const text = (spoken ?? draft).trim();
    if (!text || pending !== null) return;
    setDraft("");
    setSendError(false);
    setPending(text);
    // שתי מהירויות: מזהה לתור, וסקר כל 0.7 שניות עד שהתשובה המלאה חוזרת. התשובה
    // המיידית (בלי כלים ובלי נתונים) מוצגת כבועה אפורה זמנית ומוחלפת בתשובה האמיתית.
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
          // תצוגה בלבד
        }
      }
    };
    void poll();
    try {
      const res = await fetch("/api/assistant/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // voice: true = ההודעה הגיעה מהמיקרופון. השרת לא מבצע ממנה פעולות שמשנות
        // כסף, מלאי או משלוח בלי אישור (תמלול יכול לטעות במספר או בשם).
        body: JSON.stringify({ text, actor, voice: Boolean(spoken), turn }),
      });
      polling = false;
      if (res.status === 401) {
        onAuthLost();
        return;
      }
      if (!res.ok) throw new Error(`http ${res.status}`);
      const data = (await res.json().catch(() => null)) as { answer?: string; pending?: { id: number; summary: string }[] } | null;
      if (speakRef.current && data?.answer) speak(data.answer);
      await queryClient.invalidateQueries({ queryKey: ["bruno-chat"] });
    } catch {
      setSendError(true);
      setDraft(text); // give the message back instead of losing it
    } finally {
      polling = false;
      setQuick(null);
      setPending(null);
    }
  }

  async function sendReceipt(file: File) {
    if (pending !== null) return;
    setSendError(false);
    setPending("📎 קבלה נשלחת — ברונו קורא אותה…");
    try {
      const blob = await shrinkImage(file);
      const res = await fetch(`/api/assistant/chat?actor=${encodeURIComponent(actor)}`, {
        method: "POST",
        headers: { "content-type": blob.type || "image/jpeg" },
        body: blob,
      });
      if (res.status === 401) {
        onAuthLost();
        return;
      }
      if (!res.ok) throw new Error(`http ${res.status}`);
      await queryClient.invalidateQueries({ queryKey: ["bruno-chat"] });
    } catch {
      setSendError(true);
    } finally {
      setPending(null);
      if (fileRef.current) fileRef.current.value = ""; // allow re-sending the same photo
    }
  }

  const speakerColor: Record<string, string> = {
    יוגב: "#0073ea",
    דימה: "#a25ddc",
    שותף: "#676879",
  };

  let lastDay = "";
  const lastId = messages.length ? messages[messages.length - 1].id : -1;

  return (
    <div
      className={
        embedded
          ? // בטלפון השיחה תופסת את כל המסך (מעל הניווט של הלוח, שגובהו כשליש מסך);
            // במסך רחב היא פאנל רגיל מתחת לניווט.
            "fixed inset-0 z-[60] flex flex-col bg-[var(--hob-surface)] pt-[env(safe-area-inset-top)] sm:static sm:z-auto sm:mx-auto sm:h-[calc(100dvh-150px)] sm:min-h-[420px] sm:max-w-3xl sm:overflow-hidden sm:rounded-2xl sm:border sm:border-[var(--hob-rule)] sm:pt-0 sm:shadow-sm"
          : "mx-auto flex h-[calc(100dvh-190px)] min-h-[420px] max-w-3xl flex-col overflow-hidden rounded-2xl bg-[var(--hob-surface)] shadow-sm"
      }
    >
      {embedded && (
        <div className="flex items-center gap-2.5 border-b border-[var(--hob-rule)] px-3.5 py-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-full border-2 border-[var(--hob-accent)] bg-[var(--hob-bg)] text-lg">🤖</span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-[var(--hob-ink)]">ברונו</div>
            <div className="text-[11px] text-[var(--hob-faint)]">מנכ"ל · מחלק את העבודה לצוות</div>
          </div>
          {"speechSynthesis" in globalThis && (
            <button
              type="button"
              onClick={toggleSpeak}
              title={speakOn ? "ברונו מקריא את התשובות. לחיצה משתיקה" : "שברונו יקריא את התשובות בקול"}
              aria-pressed={speakOn}
              className={`flex h-8 w-8 items-center justify-center rounded-lg border text-sm ${speakOn ? "border-[var(--hob-accent)] bg-[var(--hob-hover)]" : "border-[var(--hob-rule-strong)] opacity-60"}`}
            >
              {speakOn ? "🔊" : "🔈"}
            </button>
          )}
          {onClose && (
            <button type="button" onClick={onClose} className="rounded-lg border border-[var(--hob-rule-strong)] px-3 py-1.5 text-xs text-[var(--hob-ink)] hover:bg-[var(--hob-hover)]">
              חזרה לצוות
            </button>
          )}
        </div>
      )}
      <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto px-3 py-4 sm:px-5">
        {query.isLoading && (
          <div className="py-16 text-center text-[var(--hob-faint)]">טוען את השיחה…</div>
        )}
        {!query.isLoading && messages.length === 0 && !pending && (
          <div className="py-16 text-center text-[var(--hob-faint)]">
            <div className="mb-2 text-3xl">🤖</div>
            זה הצ'אט עם ברונו — אותו ברונו, בלי טלגרם.
            <br />
            אפשר לרשום מכירות והוצאות, לשאול על מלאי, יעדים ומשימות.
          </div>
        )}
        {messages.map((m) => {
          const isUser = m.role === "user";
          const { speaker, text } = isUser
            ? splitSpeaker(m.content)
            : { speaker: "ברונו", text: m.content };
          const day = dayLabel(m.created_at);
          const showDay = day !== lastDay;
          lastDay = day;
          const mine = isUser && speaker !== "" && actor !== "" &&
            ((actor === "yogev" && speaker === "יוגב") || (actor === "dima" && speaker === "דימה"));
          return (
            <div key={m.id}>
              {showDay && (
                <div className="my-3 text-center">
                  <span className="rounded-full bg-[var(--hob-hover)] px-3 py-0.5 text-xs text-[var(--hob-soft)]">
                    {day}
                  </span>
                </div>
              )}
              <div dir="rtl" className={`mb-2.5 flex ${isUser ? "justify-end" : "justify-start"}`}>
                <div
                  className={`whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-start text-sm leading-relaxed ${
                    isUser
                      ? `max-w-[85%] sm:max-w-[70%] ${mine ? "bg-[#e3f0ff]" : "bg-[#f1e9fb]"} text-[#14142b]`
                      : "w-full max-w-[94%] border border-[var(--hob-rule)] bg-[var(--hob-bg)] sm:max-w-[82%]"
                  }`}
                >
                  <div
                    className="mb-0.5 text-xs font-bold"
                    style={{ color: isUser ? (speakerColor[speaker] ?? "#676879") : "var(--hob-soft)" }}
                  >
                    {isUser ? speaker || "שותף" : "🤖 ברונו"}
                  </div>
                  <LongText text={text} startOpen={m.id === lastId} user={isUser} />
                  <div className="mt-1 text-end text-[10px] text-[var(--hob-faint)]">
                    {timeLabel(m.created_at)}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
        {pending !== null && (
          <>
            <div className="mb-2 flex justify-end">
              <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-[#e3f0ff] text-start px-3.5 py-2 text-sm leading-relaxed shadow-sm sm:max-w-[75%]">
                <div className="mb-0.5 text-xs font-bold" style={{ color: speakerColor[actor === "dima" ? "דימה" : "יוגב"] }}>
                  {actor === "dima" ? "דימה" : "יוגב"}
                </div>
                <div className="text-[var(--hob-ink)]">{pending}</div>
              </div>
            </div>
            {quick ? (
              <div dir="rtl" className="mb-2 flex justify-start">
                <div className="w-full max-w-[94%] whitespace-pre-wrap rounded-2xl bg-[var(--hob-bg2)] px-3.5 py-2 text-start text-sm leading-relaxed text-[var(--hob-soft)] shadow-sm sm:max-w-[82%]">
                  <div className="mb-0.5 text-xs font-bold text-[var(--hob-faint)]">🤖 ברונו · מיידי</div>
                  <div>{quick}</div>
                  <div className="mt-1 text-[10px] text-[var(--hob-faint)]">
                    בודק לעומק<span className="animate-pulse">…</span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="mb-2 flex justify-start">
                <div className="rounded-2xl bg-[var(--hob-bg2)] px-3.5 py-2 text-sm text-[var(--hob-soft)] shadow-sm">
                  🤖 ברונו חושב<span className="animate-pulse">…</span>
                </div>
              </div>
            )}
          </>
        )}
        {sendError && (
          <div className="mb-2 text-center text-xs text-[#e2445c]">
            ההודעה לא נשלחה — נסו שוב.
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      {held.map((h) => (
        <div key={h.id} className="mx-3 mb-2 rounded-xl border border-[#fdab3d] bg-[var(--hob-bg)] p-3">
          <div className="text-xs font-medium text-[#fdab3d]">{h.state === "unknown" ? "לא ידוע אם בוצע" : "מחכה לאישור שלך, עוד לא בוצע"}</div>
          <div className="mt-1 text-sm leading-relaxed text-[var(--hob-ink)]">{h.summary}</div>
          {h.note && <div className="mt-1 text-xs text-[#f0768a]">{h.note}</div>}
          <div className="mt-2 flex gap-2">
            {h.state === "unknown" ? (
              <button type="button" onClick={() => void closeUnknown(h.id)} className="rounded-lg border border-[var(--hob-rule-strong)] px-4 py-1.5 text-sm text-[var(--hob-ink)]">
                בדקתי ביומן, סגור
              </button>
            ) : (
              <>
                <button type="button" disabled={confirming} onClick={() => void answerHeld(h.id, true)} className="rounded-lg bg-[var(--hob-accent)] px-4 py-1.5 text-sm font-medium text-[var(--hob-accent-fg)] disabled:opacity-50">
                  אשר ובצע
                </button>
                <button type="button" disabled={confirming} onClick={() => void answerHeld(h.id, false)} className="rounded-lg border border-[var(--hob-rule-strong)] px-4 py-1.5 text-sm text-[var(--hob-ink)] disabled:opacity-50">
                  בטל
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
          title="תמונה: קבלה נרשמת כהוצאה, וצילום מסך של רילז או בגד עובר למיכאלה"
          className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-xl border border-[var(--hob-rule-strong)] bg-[var(--hob-surface)] text-lg transition-opacity disabled:opacity-40"
        >
          📷
        </button>
        {voiceOk && (
          <button
            type="button"
            onClick={toggleMic}
            disabled={pending !== null || transcribing}
            title={listening ? "מקליט. לחיצה עוצרת ושולחת" : "לדבר עם ברונו"}
            aria-pressed={listening}
            className={`flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-xl border text-lg transition disabled:opacity-40 ${
              listening ? "animate-pulse border-[#e2445c] bg-[#e2445c] text-white" : "border-[var(--hob-rule-strong)] bg-[var(--hob-surface)]"
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
          placeholder={listening ? "מקליט… לחץ שוב לשליחה" : transcribing ? "מתמלל…" : "כתבו לברונו…"}
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
