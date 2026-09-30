// ⚙️ הגדרות: the brand's settings (one form over the `settings` table), the
// logged-in partner's password, and phone notifications for this device.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";

import { api, post, type BoardUser } from "./board";
import { toast } from "./toast";

type Settings = Record<string, string>;
type SettingsResponse = { ok: boolean; settings: Settings; user: BoardUser };
type PushInfo = { ok: boolean; key: string; devices: number; mine: number };

const FIELDS: { key: string; label: string; hint?: string; kind: "text" | "textarea" | "number" | "toggle" | "url" }[] = [
  { key: "brand_name", label: "שם המותג", kind: "text" },
  { key: "assistant_name", label: "שם העוזרת", hint: "איך קוראים לה בצ'אט ובהתראות", kind: "text" },
  { key: "brand_context", label: "רקע על המותג", hint: "מה הובי צריכה לדעת על המותג: סגנון, קהל, מוצרים, מחירים", kind: "textarea" },
  { key: "owner_context", label: "רקע עליכן", hint: "מי עושה מה, איך אתן אוהבות לעבוד", kind: "textarea" },
  { key: "shop_domain", label: "דומיין החנות ב-Shopify", hint: "לדוגמה my-shop.myshopify.com", kind: "text" },
  { key: "store_url", label: "כתובת האתר ללקוחות", hint: "https://...", kind: "url" },
  { key: "collab_domain", label: "דומיין לקישורי משפיעניות", hint: "הדומיין שממנו נשלחים הקישורים האישיים", kind: "text" },
  { key: "collab_discount_pct", label: "הנחה למשפיעניות %", kind: "number" },
  { key: "collab_commission_pct", label: "עמלה למשפיעניות %", kind: "number" },
  { key: "fee_rates", label: "עמלת סליקה שופיפיי %", hint: "אחוז מכל מכירה באתר", kind: "number" },
  { key: "vat_exempt", label: "עוסקת פטורה (בלי מע\"מ)", kind: "toggle" },
];

/** fee_rates is stored as JSON {"shopify":0.024}; the form shows 2.4. */
function feePct(json: string): string {
  try {
    const v = (JSON.parse(json || "{}") as { shopify?: number }).shopify;
    return typeof v === "number" ? String(Math.round(v * 10000) / 100) : "";
  } catch {
    return "";
  }
}

function toForm(s: Settings): Settings {
  return { ...s, fee_rates: feePct(s.fee_rates ?? "") };
}

function urlB64ToU8(b64: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const input = "h-10 w-full rounded-lg border border-[var(--hob-rule-strong)] bg-[var(--hob-surface)] px-3 text-sm text-[var(--hob-ink)] outline-none focus:border-[var(--hob-accent)]";
const primary = "h-10 rounded-lg bg-[var(--hob-accent)] px-4 text-sm font-bold text-[var(--hob-accent-fg)] hover:bg-[var(--hob-accent-hover)] disabled:opacity-50";
const secondary = "h-10 rounded-lg border border-[var(--hob-rule-strong)] px-4 text-sm font-medium text-[var(--hob-ink)] hover:bg-[var(--hob-hover)] disabled:opacity-50";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-6 rounded-xl border border-[var(--hob-rule)] bg-[var(--hob-surface)] p-4 sm:p-5">
      <h2 className="mb-3 text-base font-bold text-[var(--hob-ink)]">{title}</h2>
      {children}
    </section>
  );
}

export function SettingsView({ user, onAuthLost }: { user: BoardUser; onAuthLost: () => void }) {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ["settings"], queryFn: () => api<SettingsResponse>("/api/settings"), retry: false });
  useEffect(() => {
    if (query.error && (query.error as Error).message === "unauthorized") onAuthLost();
  }, [query.error, onAuthLost]);

  const [form, setForm] = useState<Settings | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    if (query.data && form === null) setForm(toForm(query.data.settings));
  }, [query.data, form]);

  type SaveResult = { ok: boolean; settings?: Settings; errors?: Record<string, string> };
  const saveM = useMutation({
    mutationFn: (values: Settings): Promise<SaveResult> =>
      api<SaveResult>("/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "save", values }) }).catch(async (e: Error): Promise<SaveResult> => {
        if (e.message === "unauthorized") throw e;
        return { ok: false, errors: e.message.includes("400") ? await lastErrors(values) : { _: "לא נשמר" } };
      }),
    onError: (e: Error) => (e.message === "unauthorized" ? onAuthLost() : toast("אין תשובה מהשרת", "error")),
    onSuccess: (r) => {
      if (r.ok && r.settings) {
        setErrors({});
        setForm(toForm(r.settings));
        toast("ההגדרות נשמרו ✓");
        void qc.invalidateQueries({ queryKey: ["settings"] });
      } else {
        setErrors(r.errors ?? { _: "לא נשמר" });
        toast("יש שדות לא תקינים", "error");
      }
    },
  });
  // A 400 carries the field errors in its body; api() throws before reading it,
  // so the failed save is repeated with plain fetch to read them.
  const lastErrors = async (values: Settings): Promise<Record<string, string>> => {
    try {
      const res = await fetch("/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "save", values }) });
      const data = (await res.json()) as { errors?: Record<string, string> };
      return data.errors ?? { _: "לא נשמר" };
    } catch {
      return { _: "לא נשמר" };
    }
  };

  // ---- password ----
  const [pw, setPw] = useState({ current: "", next: "", again: "" });
  const pwM = useMutation({
    mutationFn: async (v: { current: string; next: string }) => {
      const res = await fetch("/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "password", ...v }) });
      if (res.status === 401) throw new Error("unauthorized");
      return (await res.json()) as { ok: boolean; code?: string };
    },
    onSuccess: (r) => {
      if (r.ok) {
        setPw({ current: "", next: "", again: "" });
        toast("הסיסמה הוחלפה ✓");
      } else toast(r.code === "wrong_password" ? "הסיסמה הנוכחית שגויה" : r.code === "weak_password" ? "סיסמה חדשה: לפחות 8 תווים" : "לא הוחלף", "error");
    },
    onError: (e: Error) => (e.message === "unauthorized" ? onAuthLost() : toast("אין תשובה מהשרת", "error")),
  });
  const submitPw = (e: FormEvent) => {
    e.preventDefault();
    if (pw.next !== pw.again) return toast("הסיסמה החדשה לא זהה בשני השדות", "error");
    if (pw.next.length < 8) return toast("סיסמה חדשה: לפחות 8 תווים", "error");
    pwM.mutate({ current: pw.current, next: pw.next });
  };

  // ---- phone notifications (this device) ----
  const pushQ = useQuery({ queryKey: ["push-info"], queryFn: () => api<PushInfo>("/api/push"), retry: false });
  const [pushState, setPushState] = useState<"unknown" | "unsupported" | "off" | "on" | "denied">("unknown");
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return setPushState("unsupported");
    if (Notification.permission === "denied") return setPushState("denied");
    navigator.serviceWorker
      .getRegistration("/sw.js")
      .then((reg) => reg?.pushManager.getSubscription())
      .then((sub) => setPushState(sub ? "on" : "off"))
      .catch(() => setPushState("off"));
  }, []);
  const [pushBusy, setPushBusy] = useState(false);
  const enablePush = async () => {
    setPushBusy(true);
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setPushState(perm === "denied" ? "denied" : "off");
        toast("ההתראות לא אושרו בדפדפן", "error");
        return;
      }
      const reg = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      const info = pushQ.data ?? (await api<PushInfo>("/api/push"));
      if (!info.key) {
        toast("חסר מפתח התראות בשרת (VAPID_PUBLIC_KEY)", "error");
        return;
      }
      const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToU8(info.key) }));
      await post("/api/push", { op: "subscribe", endpoint: sub.endpoint });
      setPushState("on");
      toast("ההתראות הופעלו במכשיר הזה ✓");
      void qc.invalidateQueries({ queryKey: ["push-info"] });
    } catch (e) {
      toast(`לא הצלחתי להפעיל: ${String((e as Error).message ?? e).slice(0, 80)}`, "error");
    } finally {
      setPushBusy(false);
    }
  };
  const disablePush = async () => {
    setPushBusy(true);
    try {
      const reg = await navigator.serviceWorker.getRegistration("/sw.js");
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await post("/api/push", { op: "unsubscribe", endpoint: sub.endpoint });
        await sub.unsubscribe();
      }
      setPushState("off");
      toast("ההתראות כובו במכשיר הזה");
      void qc.invalidateQueries({ queryKey: ["push-info"] });
    } finally {
      setPushBusy(false);
    }
  };
  const testM = useMutation({
    mutationFn: () => post("/api/push", { op: "test" }) as Promise<{ ok: boolean; sent?: number; failed?: number }>,
    onSuccess: (r) => toast(r.sent ? `נשלחה ל-${r.sent} מכשירים` : "לא נשלח לאף מכשיר. בדקו שההתראות מופעלות ושיש מפתחות בשרת", r.sent ? "ok" : "error"),
    onError: () => toast("אין תשובה מהשרת", "error"),
  });

  if (query.isLoading || !form) return <div className="py-24 text-center text-[var(--hob-faint)]">טוען הגדרות…</div>;
  if (query.isError) return <div className="py-24 text-center text-[#e2445c]">לא הצלחתי לטעון את ההגדרות. נסו לרענן.</div>;

  const standaloneHint = typeof window !== "undefined" && /iphone|ipad/i.test(navigator.userAgent) && !window.matchMedia("(display-mode: standalone)").matches;

  return (
    <div className="mx-auto max-w-2xl" dir="rtl">
      <Section title="המותג">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            saveM.mutate(form);
          }}
          className="space-y-3"
        >
          {FIELDS.map((f) => (
            <div key={f.key}>
              <label className="mb-1 block text-[13px] font-medium text-[var(--hob-ink)]" htmlFor={`s-${f.key}`}>
                {f.label}
              </label>
              {f.kind === "textarea" ? (
                <textarea id={`s-${f.key}`} value={form[f.key] ?? ""} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} rows={4} className={`${input} h-auto py-2 leading-relaxed`} />
              ) : f.kind === "toggle" ? (
                <label className="flex h-10 cursor-pointer items-center gap-2 text-sm text-[var(--hob-ink)]">
                  <input type="checkbox" checked={form[f.key] === "1"} onChange={(e) => setForm({ ...form, [f.key]: e.target.checked ? "1" : "0" })} className="h-5 w-5" />
                  <span>{form[f.key] === "1" ? "כן, פטורה ממע\"מ" : "לא, העסק גובה מע\"מ"}</span>
                </label>
              ) : (
                <input
                  id={`s-${f.key}`}
                  type={f.kind === "number" ? "number" : "text"}
                  inputMode={f.kind === "number" ? "decimal" : undefined}
                  dir={f.kind === "number" || f.kind === "url" || f.key.endsWith("domain") ? "ltr" : undefined}
                  step={f.kind === "number" ? "0.1" : undefined}
                  value={form[f.key] ?? ""}
                  onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                  className={input}
                />
              )}
              {errors[f.key] ? <div className="mt-1 text-xs text-[#e2445c]">{errors[f.key]}</div> : f.hint ? <div className="mt-1 text-xs text-[var(--hob-faint)]">{f.hint}</div> : null}
            </div>
          ))}
          {errors._ && <div className="text-xs text-[#e2445c]">{errors._}</div>}
          <div className="flex items-center gap-2 pt-1">
            <button type="submit" disabled={saveM.isPending} className={primary}>
              {saveM.isPending ? "שומר…" : "שמירה"}
            </button>
            <button type="button" onClick={() => query.data && setForm(toForm(query.data.settings))} className={secondary}>
              ביטול שינויים
            </button>
          </div>
        </form>
      </Section>

      <Section title={`הסיסמה של ${user.name}`}>
        <form onSubmit={submitPw} className="grid gap-3 sm:grid-cols-3">
          <input type="password" autoComplete="current-password" placeholder="סיסמה נוכחית" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} className={input} />
          <input type="password" autoComplete="new-password" placeholder="סיסמה חדשה (8+ תווים)" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} className={input} />
          <input type="password" autoComplete="new-password" placeholder="שוב הסיסמה החדשה" value={pw.again} onChange={(e) => setPw({ ...pw, again: e.target.value })} className={input} />
          <div className="sm:col-span-3">
            <button type="submit" disabled={pwM.isPending || !pw.current || !pw.next} className={primary}>
              החלפת סיסמה
            </button>
          </div>
        </form>
      </Section>

      <Section title="התראות לטלפון">
        <p className="mb-3 text-[13px] leading-relaxed text-[var(--hob-soft)]">
          הזמנה חדשה, תדריך הבוקר ותזכורות מגיעים כהתראה למכשיר הזה. הובי שולחת רק מה שחשוב: לא בלילה, ולא יותר משלוש ביום (חוץ מהזמנות).
          {standaloneHint && <span className="block mt-1 text-[var(--hob-faint)]">באייפון: קודם "הוספה למסך הבית" בספארי, ואז להפעיל מתוך האפליקציה.</span>}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {pushState === "unsupported" && <span className="text-sm text-[var(--hob-faint)]">הדפדפן הזה לא תומך בהתראות.</span>}
          {pushState === "denied" && <span className="text-sm text-[#e2445c]">ההתראות חסומות בהגדרות הדפדפן למכשיר הזה.</span>}
          {(pushState === "off" || pushState === "unknown") && (
            <button type="button" disabled={pushBusy || pushState === "unknown"} onClick={() => void enablePush()} className={primary}>
              🔔 הפעלת התראות במכשיר הזה
            </button>
          )}
          {pushState === "on" && (
            <>
              <span className="text-sm text-[var(--hob-good)]">✓ מופעל במכשיר הזה</span>
              <button type="button" disabled={testM.isPending} onClick={() => testM.mutate()} className={secondary}>
                בדיקת התראה
              </button>
              <button type="button" disabled={pushBusy} onClick={() => void disablePush()} className="h-10 px-2 text-sm text-[var(--hob-faint)] underline underline-offset-2">
                כיבוי
              </button>
            </>
          )}
        </div>
        {pushQ.data && (
          <div className="mt-2 text-xs text-[var(--hob-faint)]">
            {pushQ.data.devices === 0 ? "אף מכשיר עוד לא רשום." : `${pushQ.data.devices} מכשירים רשומים (${pushQ.data.mine} שלך).`}
            {!pushQ.data.key && " חסר מפתח VAPID בשרת (scripts/vapid-keys.mjs)."}
          </div>
        )}
      </Section>
    </div>
  );
}
