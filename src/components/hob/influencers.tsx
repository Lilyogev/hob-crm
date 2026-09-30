import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { DeleteButton, EditableText, api, parseMoney, post } from "./board";
import { nis } from "./money";
import { ProspectCard } from "./prospect-card";
import { toast } from "./toast";

// ---- 🤝 משפיענים: the influencer collab program tab (phase 1) ----
//
// Creates personal invite links (/c/<token>), shows who signed up through
// them, and tracks each signup through the pipeline:
// נרשמה → נשלח מוצר → פרסמה → הסתיים.

type Campaign = {
  id: number;
  slug: string;
  title: string;
  product_name: string;
  product_value: number;
  asks: string;
  brief: string;
  sizes: string;
};

type Product = {
  id: number;
  name: string;
  value: number;
  image: string;
  sizes: string;
  colors: string;
};

type Link = {
  id: number;
  token: string;
  name: string;
  instagram: string;
  product_id: number | null;
  picks: number;
  views: number;
  discount_code: string;
  sale_clicks: number;
  personal_note: string;
  is_generic: number;
  commission_paid: number;
  combines_ok: number;
  code_ended_at: string;
  created_at: string;
  signups: number;
  sales_count: number;
  sales_total: number;
};

type Signup = {
  id: number;
  link_id: number | null;
  full_name: string;
  instagram: string;
  phone: string;
  email: string;
  size: string;
  color: string;
  product: string;
  reel_url: string;
  reel_views: number;
  file_received: number;
  address: string;
  city: string;
  apt: string;
  floor: string;
  is_private: number;
  zip: string;
  status: string;
  created_at: string;
};

type Prospect = {
  id: number;
  name: string;
  instagram: string;
  followers: number;
  gender: string;
  niche: string;
  note: string;
  personal: string;
  status: string;
  link_id: number | null;
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
  package_sent_at: string;
  shoot: string;
  version: string;
};

type CollabData = {
  ok: boolean;
  campaign: Campaign | null;
  products: Product[];
  links: Link[];
  signups: Signup[];
  prospects: Prospect[];
};

// המסלול של ליה (0080): מועמד → אושר לפנייה → נשלחה פנייה → ענה → סוכמו תנאים →
// חבילה/צילום → התקבל תוכן → הושלם. הכפתור הצבעוני מקדם שלב אחד; ↩ מחזיר.
const PSTATUS: { key: string; label: string; bg: string }[] = [
  { key: "candidate", label: "מועמד", bg: "#fdab3d" },
  { key: "to_contact", label: "אושר לפנייה", bg: "#676879" },
  { key: "contacted", label: "נשלחה פנייה", bg: "#0073ea" },
  { key: "talking", label: "ענה", bg: "#a25ddc" },
  { key: "agreed", label: "סוכמו תנאים", bg: "#7e3af2" },
  { key: "package_sent", label: "חבילה נשלחה", bg: "#0086c0" },
  { key: "shoot_set", label: "צילום נקבע", bg: "#00a2b8" },
  { key: "scheduled", label: "לבירור: חבילה או צילום?", bg: "#c98a00" },
  { key: "received", label: "התקבל תוכן", bg: "#00a359" },
  { key: "done", label: "הושלם", bg: "#037f4c" },
  { key: "linked", label: "נוצר לינק", bg: "#00a359" },
  { key: "rejected", label: "לארכיון", bg: "#e2445c" },
];
// חבילה וצילום נפרדים (0083). הכפתור הצבעוני מקדם מ"סוכמו תנאים" לחבילה בלבד; "צילום נקבע"
// נכנס רק מהטופס בכרטיס, עם אישור מפורש ופרטים. scheduled = רשומה ישנה, נפתרת בכרטיס.
const NEXT: Record<string, string> = { candidate: "to_contact", to_contact: "contacted", contacted: "talking", talking: "agreed", agreed: "package_sent", package_sent: "received", shoot_set: "received", received: "done" };
const PREV: Record<string, string> = { to_contact: "candidate", contacted: "to_contact", talking: "contacted", agreed: "talking", package_sent: "agreed", shoot_set: "agreed", scheduled: "agreed", done: "received" };

function fmtFollowers(n: number): string {
  if (n >= 1000) return `${Math.round(n / 100) / 10}K`;
  return String(n);
}

const STATUS: { key: string; label: string; bg: string }[] = [
  { key: "signed", label: "מאושרת", bg: "#0073ea" },
  { key: "sent", label: "נשלח מוצר", bg: "#a25ddc" },
  { key: "posted", label: "פרסמה", bg: "#00a359" },
  { key: "done", label: "הסתיים", bg: "#676879" },
];

function statusOf(key: string) {
  return STATUS.find((s) => s.key === key) ?? STATUS[0];
}

// Public-facing links always use the brand domain — a workers.dev URL reads
// like phishing in a DM and some Israeli carriers block the domain outright.
const COLLAB_BASE = "https://collab.segula.club";

function pageURL(token: string): string {
  return `${COLLAB_BASE}/c/${token}`;
}

// Opens WhatsApp with a ready invite message — the sender just picks the chat.
const COMMISSION_PCT = 0.1;

function saleURL(code: string): string {
  // The tracking hop: counts the click, then forwards to the store with the
  // discount armed.
  return `${COLLAB_BASE}/s/${code}`;
}

// Her private stats page — clicks, orders, commission, updated live.
function myURL(token: string): string {
  return `${COLLAB_BASE}/my/${token}`;
}

// The "you're in" WhatsApp: her code, what it gives, her share link, her
// stats page, and the next step — one tap after approving, no manual
// drafting per influencer.
function waApproveURL(
  s: { full_name: string; phone: string },
  code: string,
  token: string,
): string {
  const first = s.full_name.trim().split(/\s+/)[0] || s.full_name;
  const digits = s.phone.replace(/\D/g, "").replace(/^0/, "972");
  const msg =
    `היי ${first}! התקבלת למועדון של סגולה 🖤\n` +
    `הקוד האישי שלך: ${code}\n` +
    `הוא נותן לעוקבים שלך 10% הנחה על כל החנות, ומכל הזמנה שנכנסת איתו מגיעים לך 10%.\n` +
    `הלינק שלך לשיתוף: ${saleURL(code)}\n` +
    `הדף האישי שלך, עם כל ההזמנות והעמלות בזמן אמת: ${myURL(token)}\n` +
    `המוצר בדרך אליך! אחרי שהוא מגיע: רילס תוך 10 ימים עם תיוג @segula.club. לכל שאלה אנחנו כאן 🙏`;
  return `https://wa.me/${digits}?text=${encodeURIComponent(msg)}`;
}

function waShareURL(l: Link): string {
  const first = l.name.trim().split(/\s+/)[0] || l.name;
  const msg =
    `היי ${first}! כאן סגולה 🖤\n` +
    `אנחנו מזמינים אותך לשתף איתנו פעולה. הכנו לך עמוד אישי עם כל הפרטים:\n` +
    pageURL(l.token);
  return `https://wa.me/?text=${encodeURIComponent(msg)}`;
}

// סיום שיתוף פעולה: שתי לחיצות, כי הקוד מפסיק לעבוד לכל העוקבים שלה מיד.
// הקוד לא נמחק — העמלה שנצברה וההזמנות שכבר נזקפו נשארות במקום.
function EndCodeButton({ name, onConfirm }: { name: string; onConfirm: () => void }) {
  const [arming, setArming] = useState(false);
  if (!arming) {
    return (
      <button
        type="button"
        title={`סיום שיתוף הפעולה: הקוד של ${name} יפסיק לעבוד בחנות. העמלה שנצברה נשארת`}
        onClick={() => setArming(true)}
        className="rounded-md border border-[var(--hob-rule)] px-2 py-0.5 text-[11.5px] text-[var(--hob-faint)] hover:bg-[var(--hob-hover)]"
      >
        סיום
      </button>
    );
  }
  return (
    <span className="relative flex items-center">
      <span className="fixed inset-0 z-30" onClick={() => setArming(false)} />
      <button
        type="button"
        onClick={() => {
          setArming(false);
          onConfirm();
        }}
        className="z-40 rounded-md bg-[#e2445c] px-2 py-0.5 text-[11.5px] font-bold text-white hover:bg-[#c93a4f]"
      >
        לסגור את הקוד?
      </button>
    </span>
  );
}

export function InfluencersView({ onAuthLost }: { onAuthLost: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [insta, setInsta] = useState("");
  // Drives the public hero: "רוצה להיות SEGULA BOY/GIRL?"; empty = neutral copy
  const [linkGender, setLinkGender] = useState("");
  // "0:N" = they pick N items from stock themselves; a number = fixed product
  const [productSel, setProductSel] = useState<string>("0:1");
  const [copied, setCopied] = useState<number | null>(null);
  // Prospect list controls: free-text search + one tag chip + one status chip,
  // all ANDed — "כדורגל שעוד לא פנינו אליהם" is the whole point.
  const [pQuery, setPQuery] = useState("");
  const [pTag, setPTag] = useState<string>("");
  const [pStatus, setPStatus] = useState<string>("");
  // Archive needs a second tap ("לארכיון?") — a one-tap 🗄️ next to the status
  // pill got hit by accident on day one.
  const [armArchive, setArmArchive] = useState<number | null>(null);

  const q = useQuery({
    queryKey: ["collab"],
    queryFn: () => api<CollabData>("/api/collab"),
    refetchInterval: 60_000,
    retry: (count, error) => (error as Error).message !== "unauthorized" && count < 2,
  });
  useEffect(() => {
    if (q.isError && (q.error as Error).message === "unauthorized") onAuthLost();
  }, [q.isError, q.error, onAuthLost]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["collab"] });
  const act = useMutation({
    mutationFn: (body: Record<string, unknown>) => post("/api/collab", body),
    // כשל מוצג במפורש: עדכון שלא נשמר (כולל העברה למיכאלה שנכשלה) לא נראה כמו הצלחה.
    // "מיכאלה קיבלה" מוצג רק אחרי שהעדכון וההעברה נשמרו יחד.
    onSuccess: (res) => {
      const r = (res ?? {}) as { ok?: boolean; error?: string; handoff?: string };
      if (r.ok === false) toast(r.error || "לא נשמר", "error");
      else if (r.handoff) toast("נשמר, ומיכאלה קיבלה את העדכון");
    },
    onError: () => toast("לא נשמר. בדוק חיבור ונסה שוב", "error"),
    onSettled: invalidate,
  });

  const campaign = q.data?.campaign ?? null;
  const products = q.data?.products ?? [];
  const links = q.data?.links ?? [];
  const prospects = q.data?.prospects ?? [];
  const signups = q.data?.signups ?? [];

  const activeProspects = prospects.filter((p) => p.status !== "rejected");
  const [openCard, setOpenCard] = useState<number | null>(null);
  const [seeds, setSeeds] = useState("");
  const tagOf = (p: Prospect) => `${p.note} ${p.niche}`;
  const pNeedle = pQuery.trim().toLowerCase();
  const visibleProspects = activeProspects.filter((p) => {
    if (pTag && !tagOf(p).includes(pTag)) return false;
    if (pStatus && p.status !== pStatus) return false;
    if (
      pNeedle &&
      !`${p.name} ${p.instagram} ${p.niche} ${p.note}`.toLowerCase().includes(pNeedle)
    )
      return false;
    return true;
  });
  const pFiltering = !!(pTag || pStatus || pNeedle);

  const copyLink = async (link: Link) => {
    try {
      await navigator.clipboard.writeText(pageURL(link.token));
      setCopied(link.id);
      setTimeout(() => setCopied(null), 1600);
    } catch {
      // Clipboard can be blocked — the URL is visible in the row anyway.
    }
  };

  if (q.isLoading) {
    return <div className="py-24 text-center text-[var(--hob-faint)]">טוען משפיענים…</div>;
  }
  if (!campaign) {
    return (
      <div className="py-24 text-center text-[var(--hob-faint)]">
        אין קמפיין פעיל — צריך שורה ב-collab_campaigns.
      </div>
    );
  }

  const card = "rounded-xl border border-[var(--hob-rule)] bg-[var(--hob-surface)] p-4";
  const input =
    "w-full rounded-lg border border-[var(--hob-rule)] bg-[var(--hob-bg)] px-3 py-2 text-[14px] text-[var(--hob-ink)] outline-none focus:border-[var(--hob-ink)]";

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-3 py-5">
      {/* Campaign settings — what the public page shows, editable in place */}
      <div className={card}>
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="text-[15px] font-extrabold text-[var(--hob-ink)]">
            🤝 {campaign.title}
          </h2>
          <span className="text-[12px] text-[var(--hob-faint)]">
            מה שכתוב כאן מופיע בעמוד הציבורי
          </span>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-6">
          <div className="flex items-center gap-2">
            <span className="text-[12.5px] text-[var(--hob-faint)]">מוצר:</span>
            <EditableText
              value={campaign.product_name}
              className="text-[13.5px] font-semibold text-[var(--hob-ink)]"
              onSave={(v) =>
                act.mutate({ action: "update_campaign", id: campaign.id, product_name: v })
              }
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[12.5px] text-[var(--hob-faint)]">שווי ₪:</span>
            <EditableText
              value={String(campaign.product_value)}
              className="text-[13.5px] font-semibold text-[var(--hob-ink)]"
              inputMode="decimal"
              onSave={(v) => {
                const n = parseMoney(v);
                if (Number.isFinite(n) && n > 0)
                  act.mutate({ action: "update_campaign", id: campaign.id, product_value: n });
              }}
            />
          </div>
        </div>
        <div className="mt-2 flex items-start gap-2">
          <span className="mt-0.5 text-[12.5px] text-[var(--hob-faint)]">בריף:</span>
          <EditableText
            value={campaign.brief}
            placeholder="הטקסט הקריאייטיבי שמופיע בעמוד"
            className="text-[13px] text-[var(--hob-ink)]"
            onSave={(v) => act.mutate({ action: "update_campaign", id: campaign.id, brief: v })}
          />
        </div>
      </div>

      {/* Funnel */}
      {links.length > 0 && (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          {(() => {
            const opened = links.filter((l) => l.views > 0 || l.signups > 0).length;
            const approved = signups.filter((x) => x.status !== "pending").length;
            const posted = signups.filter(
              (x) => x.status === "posted" || x.status === "done",
            ).length;
            const salesCount = links.reduce((a, l) => a + (l.sales_count || 0), 0);
            const salesTotal = links.reduce((a, l) => a + (l.sales_total || 0), 0);
            const tiles: { label: string; value: string }[] = [
              { label: "לינקים", value: String(links.length) },
              { label: "נפתחו", value: String(opened) },
              { label: "נרשמו", value: String(signups.length) },
              { label: "אושרו", value: String(approved) },
              { label: "פרסמו", value: String(posted) },
              { label: "מכירות", value: `${salesCount} · ${nis(salesTotal)}` },
            ];
            return tiles.map((t) => (
              <div
                key={t.label}
                className="rounded-xl border border-[var(--hob-rule)] bg-[var(--hob-surface)] px-2 py-3 text-center"
              >
                <div className="text-[16px] font-extrabold text-[var(--hob-ink)] [font-variant-numeric:tabular-nums]">
                  {t.value}
                </div>
                <div className="text-[11px] text-[var(--hob-faint)]">{t.label}</div>
              </div>
            ));
          })()}
        </div>
      )}

      {/* New personal link */}
      <div className={card}>
        <h3 className="mb-3 text-[14px] font-extrabold text-[var(--hob-ink)]">
          ＋ לינק אישי חדש
        </h3>
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            const [pid, picks] = productSel.split(":").map(Number);
            act.mutate({
              action: "create_link",
              campaignId: campaign.id,
              name: name.trim(),
              instagram: insta.trim(),
              productId: pid || null,
              picks: picks || 1,
              gender: linkGender,
            });
            setName("");
            setInsta("");
          }}
        >
          <input
            className={input}
            placeholder="שם (נועה כהן)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            className={input}
            placeholder="אינסטגרם בלי @ (noa.example)"
            dir="ltr"
            value={insta}
            onChange={(e) => setInsta(e.target.value)}
          />
          <select
            className={input + " sm:w-auto"}
            value={linkGender}
            onChange={(e) => setLinkGender(e.target.value)}
            title="קובע את הכותרת בדף: רוצה להיות SEGULA BOY/GIRL?"
          >
            <option value="">בלי מגדר (נוסח נייטרלי)</option>
            <option value="m">בחור · SEGULA BOY</option>
            <option value="f">בחורה · SEGULA GIRL</option>
          </select>
          <select
            className={input + " sm:w-auto"}
            value={productSel}
            onChange={(e) => setProductSel(e.target.value)}
          >
            <option value="0:1">✨ בוחרים בעצמם מהמלאי · פריט אחד</option>
            <option value="0:2">✨ בוחרים בעצמם מהמלאי · 2 פריטים</option>
            <option value="0:3">✨ בוחרים בעצמם מהמלאי · 3 פריטים</option>
            {products.map((pr) => (
              <option key={pr.id} value={`${pr.id}:1`}>
                {pr.name} · ₪{pr.value}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="flex-none rounded-lg bg-[var(--hob-ink)] px-5 py-2 text-[14px] font-bold text-[var(--hob-bg)] disabled:opacity-50"
            disabled={!name.trim() || act.isPending}
          >
            יצירת לינק
          </button>
        </form>

        {links.length > 0 && (
          <div className="mt-4 flex flex-col gap-2">
            {links.map((l) => (
              <div
                key={l.id}
                className="group flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-[var(--hob-rule)] px-3 py-2"
              >
                <span className="text-[13.5px] font-semibold text-[var(--hob-ink)]">{l.name}</span>
                {l.instagram && (
                  <a
                    href={`https://instagram.com/${l.instagram}`}
                    target="_blank"
                    rel="noopener"
                    dir="ltr"
                    className="text-[12.5px] text-[#0073ea] hover:underline"
                  >
                    @{l.instagram}
                  </a>
                )}
                <code dir="ltr" className="text-[11.5px] text-[var(--hob-faint)]">
                  /c/{l.token}
                </code>
                <span className="text-[11.5px] text-[var(--hob-faint)]">
                  {l.product_id == null
                    ? `✨ לבחירתם${l.picks > 1 ? ` · עד ${l.picks} פריטים` : ""}`
                    : (products.find((pr) => pr.id === l.product_id)?.name ?? "")}
                </span>
                {l.discount_code && l.code_ended_at ? (
                  <span
                    title={`הקוד נסגר ב-${l.code_ended_at} ולא עובד יותר בחנות. ההזמנות והעמלה שנצברו נשארו`}
                    className="rounded-md bg-[var(--hob-hover)] px-2 py-0.5 text-[11.5px] font-bold text-[var(--hob-faint)] line-through"
                    dir="ltr"
                  >
                    🔒 {l.discount_code}
                  </span>
                ) : l.discount_code ? (
                  <button
                    type="button"
                    title="העתקת לינק מכירה עם ההנחה שלה"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(saleURL(l.discount_code));
                        setCopied(-l.id);
                        setTimeout(() => setCopied(null), 1600);
                      } catch {
                        // URL visible in the title anyway
                      }
                    }}
                    className="rounded-md bg-[var(--hob-hover)] px-2 py-0.5 text-[11.5px] font-bold text-[var(--hob-ink)]"
                  >
                    {copied === -l.id ? "הועתק ✓" : `🏷️ ${l.discount_code}`}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => act.mutate({ action: "create_code", id: l.id })}
                    className="rounded-md border border-dashed border-[#e8a13a] px-2 py-0.5 text-[11.5px] font-semibold text-[#e8a13a]"
                  >
                    אין קוד — ליצור
                  </button>
                )}
                {/* קוד ישן שנוצר לפני 24.9 מבטל את ההנחות האוטומטיות של
                    החנות במקום להצטרף אליהן. הכפתור נעלם ברגע שהחנות
                    מאשרת את התיקון, ולא מופיע על קודים חדשים. */}
                {l.discount_code && !l.combines_ok && !l.code_ended_at && (
                  <button
                    type="button"
                    title="הקוד נוצר בלי שילוב הנחות: בעגלה עם סט DREAMER הוא מבטל את ההנחה האוטומטית במקום להצטרף אליה. תיקון בשופיפיי, הקוד עצמו לא משתנה."
                    onClick={() => act.mutate({ action: "fix_combinations", id: l.id })}
                    className="rounded-md border border-[#e8a13a] bg-[#e8a13a]/10 px-2 py-0.5 text-[11.5px] font-semibold text-[#e8a13a]"
                  >
                    ⚠️ מתנגש עם הנחות — לתקן
                  </button>
                )}
                {/* סיום שיתוף פעולה, והדרך חזרה אם נסגר בטעות. */}
                {l.discount_code && !l.is_generic && !l.code_ended_at && (
                  <EndCodeButton
                    name={l.name}
                    onConfirm={() =>
                      act.mutate({ action: "set_code_active", id: l.id, active: false })
                    }
                  />
                )}
                {l.discount_code && l.code_ended_at && (
                  <button
                    type="button"
                    title="החזרת הקוד לפעילות בחנות"
                    onClick={() => act.mutate({ action: "set_code_active", id: l.id, active: true })}
                    className="rounded-md border border-[var(--hob-rule)] px-2 py-0.5 text-[11.5px] text-[var(--hob-faint)] hover:bg-[var(--hob-hover)]"
                  >
                    החזרה לפעילות
                  </button>
                )}
                {l.discount_code && !l.is_generic ? (
                  <button
                    type="button"
                    title="העתקת דף הסטטיסטיקות האישי שלה: הזמנות, קליקים ועמלות"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(myURL(l.token));
                        setCopied(100000 + l.id);
                        setTimeout(() => setCopied(null), 1600);
                      } catch {
                        // URL visible in the title anyway
                      }
                    }}
                    className="rounded-md bg-[var(--hob-hover)] px-2 py-0.5 text-[11.5px] font-bold text-[var(--hob-ink)]"
                  >
                    {copied === 100000 + l.id ? "הועתק ✓" : "📊 דף אישי"}
                  </button>
                ) : null}
                <span
                  className={`text-[11.5px] font-bold ${
                    l.signups > 0
                      ? "text-[#00a359]"
                      : l.views > 0
                        ? "text-[#e8a13a]"
                        : "text-[var(--hob-faint)]"
                  }`}
                >
                  {l.signups > 0
                    ? "✓ נרשמה"
                    : l.views > 0
                      ? `נפתח ${l.views}× · לא נרשמה`
                      : "לא נפתח עדיין"}
                </span>
                <span className="ms-auto flex items-center gap-1">
                  <a
                    href={waShareURL(l)}
                    target="_blank"
                    rel="noopener"
                    className="rounded-md bg-[#25D366] px-2.5 py-1 text-[12px] font-bold text-white hover:opacity-90"
                  >
                    שליחה בווצאפ
                  </a>
                  <button
                    type="button"
                    onClick={() => copyLink(l)}
                    className="rounded-md border border-[var(--hob-rule)] px-2.5 py-1 text-[12px] font-semibold text-[var(--hob-ink)] hover:bg-[var(--hob-hover)]"
                  >
                    {copied === l.id ? "הועתק ✓" : "העתקת לינק"}
                  </button>
                  <a
                    href={`/c/${l.token}`}
                    target="_blank"
                    rel="noopener"
                    className="rounded-md border border-[var(--hob-rule)] px-2.5 py-1 text-[12px] text-[var(--hob-faint)] hover:bg-[var(--hob-hover)]"
                  >
                    פתיחה
                  </a>
                  <DeleteButton onConfirm={() => act.mutate({ action: "delete_link", id: l.id })} />
                </span>
                <span className="flex w-full items-center gap-1.5 text-[11.5px] text-[var(--hob-faint)]">
                  ✍️
                  <EditableText
                    value={l.personal_note}
                    placeholder="שורה אישית שתופיע על העמוד שלה"
                    className="text-[11.5px] text-[var(--hob-faint)]"
                    onSave={(v) => act.mutate({ action: "update_link_note", id: l.id, note: v })}
                  />
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Sales leaderboard */}
      {links.some((l) => l.discount_code || l.sales_count > 0) && (
        <div className={card}>
          <h3 className="mb-1 text-[14px] font-extrabold text-[var(--hob-ink)]">
            💸 ליגת המכירות
          </h3>
          <p className="mb-3 text-[12px] text-[var(--hob-faint)]">
            10% הנחה לקונה · 10% עמלה למשפיענית · הזמנה עם הקוד שלה נזקפת לה אוטומטית
          </p>
          <div className="flex flex-col gap-1.5">
            {links
              .filter((l) => l.discount_code || l.sales_count > 0)
              .sort((a, b) => b.sales_total - a.sales_total)
              .map((l, idx) => (
                <div
                  key={l.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-[var(--hob-rule)] px-3 py-2"
                >
                  <span className="w-5 text-center text-[13px] font-bold text-[var(--hob-faint)]">
                    {idx + 1}
                  </span>
                  <span className="text-[13.5px] font-semibold text-[var(--hob-ink)]">
                    {l.name}
                  </span>
                  {l.discount_code && (
                    <code dir="ltr" className="text-[11.5px] text-[var(--hob-faint)]">
                      {l.discount_code}
                    </code>
                  )}
                  <span className="ms-auto flex items-center gap-4 text-[12.5px] [font-variant-numeric:tabular-nums]">
                    <span>{l.sale_clicks} קליקים</span>
                    <span>
                      {l.sales_count} מכירות
                      {l.sale_clicks > 0 && l.sales_count > 0
                        ? ` (${Math.round((l.sales_count / l.sale_clicks) * 100)}%)`
                        : ""}{" "}
                      · <b className="dm text-[var(--hob-ink)]">{nis(l.sales_total)}</b>
                    </span>
                    <span className="font-bold text-[#00a359]">
                      עמלה <span className="dm">{nis(l.sales_total * COMMISSION_PCT)}</span>
                    </span>
                    {(() => {
                      const accrued = l.sales_total * COMMISSION_PCT;
                      const due = accrued - (l.commission_paid || 0);
                      if (accrued <= 0) return null;
                      return due > 0.5 ? (
                        <button
                          type="button"
                          title="סימון שהעמלה הפתוחה שולמה לה"
                          onClick={() => act.mutate({ action: "commission_paid", linkId: l.id })}
                          className="rounded-md border border-[#e8a13a] px-2 py-1 text-[12px] font-bold text-[#e8a13a] hover:bg-[#e8a13a] hover:text-white"
                        >
                          לתשלום <span className="dm">{nis(due)}</span> · ✓ שולם
                        </button>
                      ) : (
                        <span className="text-[11.5px] font-bold text-[var(--hob-faint)]">
                          ✓ שולם הכל
                        </span>
                      );
                    })()}
                  </span>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Signups */}
      <div className={card}>
        <h3 className="mb-3 text-[14px] font-extrabold text-[var(--hob-ink)]">
          הרשמות ({signups.length})
        </h3>
        {signups.length === 0 && (
          <div className="py-6 text-center text-[13px] text-[var(--hob-faint)]">
            עוד אין הרשמות — שלחו לינקים אישיים ב-DM ותראו אותן נכנסות כאן
          </div>
        )}
        <div className="flex flex-col gap-2">
          {signups.map((s) => {
            const st = statusOf(s.status);
            const next = STATUS[(STATUS.findIndex((x) => x.key === s.status) + 1) % STATUS.length];
            const prevIdx = STATUS.findIndex((x) => x.key === s.status) - 1;
            const prev = prevIdx >= 0 ? STATUS[prevIdx] : null;
            const waDigits = s.phone.replace(/\D/g, "").replace(/^0/, "972");
            return (
              <div
                key={s.id}
                className="group flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-[var(--hob-rule)] px-3 py-2.5"
              >
                <span className="text-[14px] font-bold text-[var(--hob-ink)]">{s.full_name}</span>
                {s.instagram && (
                  <a
                    href={`https://instagram.com/${s.instagram}`}
                    target="_blank"
                    rel="noopener"
                    dir="ltr"
                    className="text-[12.5px] text-[#0073ea] hover:underline"
                  >
                    @{s.instagram}
                  </a>
                )}
                {s.product && (
                  <span className="text-[12px] font-semibold text-[var(--hob-faint)]">
                    {s.product}
                  </span>
                )}
                {(s.size || s.color) && (
                  <span className="rounded-md bg-[var(--hob-hover)] px-2 py-0.5 text-[12px] font-bold text-[var(--hob-ink)]">
                    {[s.size, s.color].filter(Boolean).join(" · ")}
                  </span>
                )}
                <span className="text-[12.5px] text-[var(--hob-faint)]">
                  {s.address}
                  {s.is_private
                    ? " (בית פרטי)"
                    : `${s.floor ? ` קומה ${s.floor}` : ""}${s.apt ? ` דירה ${s.apt}` : ""}`}
                  , {s.city}
                </span>
                {s.phone && (
                  <a
                    href={`https://wa.me/${waDigits}`}
                    target="_blank"
                    rel="noopener"
                    dir="ltr"
                    className="text-[12.5px] text-[#00a359] hover:underline"
                  >
                    {s.phone}
                  </a>
                )}
                {(s.status === "posted" || s.status === "done" || s.reel_url) && (
                  <span className="flex items-center gap-2 text-[12px]">
                    {s.reel_url ? (
                      <a
                        href={s.reel_url}
                        target="_blank"
                        rel="noopener"
                        className="font-bold text-[#a25ddc] hover:underline"
                      >
                        ▶ רילס
                      </a>
                    ) : null}
                    <EditableText
                      value={s.reel_url}
                      placeholder="＋ לינק לרילס"
                      className="max-w-[120px] truncate text-[11.5px] text-[var(--hob-faint)]"
                      onSave={(v) => act.mutate({ action: "update_reel", id: s.id, reel_url: v })}
                    />
                    <span className="text-[var(--hob-faint)]">צפיות:</span>
                    <EditableText
                      value={String(s.reel_views || 0)}
                      className="text-[12px] font-bold text-[var(--hob-ink)]"
                      inputMode="numeric"
                      onSave={(v) => {
                        const n = Number(v.replace(/[^\d]/g, ""));
                        if (Number.isFinite(n))
                          act.mutate({ action: "update_reel", id: s.id, reel_views: n });
                      }}
                    />
                    <button
                      type="button"
                      title="קיבלנו ממנה את קובץ הווידאו המקורי (זכויות שימוש בממומן)"
                      onClick={() =>
                        act.mutate({ action: "file_received", id: s.id, value: !s.file_received })
                      }
                      className={
                        s.file_received
                          ? "rounded-md bg-[#a25ddc] px-2 py-0.5 text-[11.5px] font-bold text-white"
                          : "rounded-md border border-[var(--hob-rule)] px-2 py-0.5 text-[11.5px] text-[var(--hob-faint)] hover:bg-[var(--hob-hover)]"
                      }
                    >
                      {s.file_received ? "🎬 קובץ אצלנו · מוכן לממומן" : "＋ קובץ מקורי"}
                    </button>
                  </span>
                )}
                <span className="ms-auto flex items-center gap-1.5">
                  {s.status === "pending" ? (
                    <>
                      <span className="rounded-md bg-[#e8a13a] px-2.5 py-1 text-[12px] font-bold text-white">
                        ⏳ ממתינה לאישור
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          act.mutate({ action: "update_status", id: s.id, status: "signed" })
                        }
                        className="rounded-md bg-[#00a359] px-2.5 py-1 text-[12px] font-bold text-white hover:opacity-90"
                      >
                        ✓ אישור
                      </button>
                      <DeleteButton
                        onConfirm={() => act.mutate({ action: "delete_signup", id: s.id })}
                      />
                    </>
                  ) : (
                    <>
                      {(() => {
                        const link = links.find((l) => l.id === s.link_id);
                        const code = link?.discount_code;
                        if (!link || !code || !s.phone) return null;
                        return (
                          <a
                            href={waApproveURL(s, code, link.token)}
                            target="_blank"
                            rel="noopener"
                            title="ווצאפ מוכן: התקבלת + הקוד + לינק השיתוף + הצעד הבא"
                            className="rounded-md bg-[#25D366] px-2.5 py-1 text-[12px] font-bold text-white hover:opacity-90"
                          >
                            📲 הודעת אישור
                          </a>
                        );
                      })()}
                      {prev && (
                        <button
                          type="button"
                          title={`צעד אחורה: ${prev.label}`}
                          onClick={() =>
                            act.mutate({ action: "update_status", id: s.id, status: prev.key })
                          }
                          className="rounded-md border border-[var(--hob-rule)] px-1.5 py-1 text-[12px] text-[var(--hob-faint)] hover:bg-[var(--hob-hover)]"
                        >
                          ↩
                        </button>
                      )}
                      <button
                        type="button"
                        title={`מעבר לסטטוס הבא: ${next.label}`}
                        onClick={() =>
                          act.mutate({ action: "update_status", id: s.id, status: next.key })
                        }
                        className="rounded-md px-2.5 py-1 text-[12px] font-bold text-white"
                        style={{ backgroundColor: st.bg }}
                      >
                        {st.label}
                      </button>
                      <DeleteButton
                        onConfirm={() => act.mutate({ action: "delete_signup", id: s.id })}
                      />
                    </>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Outreach prospects */}
      <div className={card}>
        <h3 className="mb-1 text-[14px] font-extrabold text-[var(--hob-ink)]">
          🎯 רשימת פניות ({pFiltering ? `${visibleProspects.length} מתוך ${activeProspects.length}` : activeProspects.length})
        </h3>
        <p className="mb-3 text-[12px] text-[var(--hob-faint)]">
          לחיצה על הסטטוס מקדמת אותו · "יצירת לינק" הופכת מועמד/ת למשפיען/ית פעיל/ה
        </p>
        {activeProspects.length > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-1.5">
            <input
              value={pQuery}
              onChange={(e) => setPQuery(e.target.value)}
              placeholder="חיפוש שם / @ / נישה"
              className="h-8 w-full max-w-[240px] rounded-md border border-[var(--hob-rule)] bg-transparent px-2.5 text-[12.5px] text-[var(--hob-ink)] placeholder:text-[var(--hob-faint)] focus:outline-none"
            />
            {(
              [
                ["⚽", "⚽ כדורגל"],
                ["🔥", "🔥 כבר עוקבים"],
                ["⭐", "⭐ עוגנים"],
              ] as const
            ).map(([tag, label]) => (
              <button
                key={tag}
                type="button"
                onClick={() => setPTag(pTag === tag ? "" : tag)}
                className={`rounded-full border px-2.5 py-1 text-[12px] font-semibold ${
                  pTag === tag
                    ? "border-[var(--hob-ink)] bg-[var(--hob-ink)] text-[var(--hob-bg)]"
                    : "border-[var(--hob-rule)] text-[var(--hob-ink)] hover:bg-[var(--hob-hover)]"
                }`}
              >
                {label}
              </button>
            ))}
            <span className="mx-0.5 h-5 w-px bg-[var(--hob-rule)]" />
            {PSTATUS.filter((s) => s.key !== "rejected").map((s) => (
              <button
                key={s.key}
                type="button"
                onClick={() => setPStatus(pStatus === s.key ? "" : s.key)}
                className="rounded-full border px-2.5 py-1 text-[12px] font-semibold"
                style={
                  pStatus === s.key
                    ? { backgroundColor: s.bg, borderColor: s.bg, color: "#fff" }
                    : { borderColor: "var(--hob-rule)", color: "var(--hob-ink)" }
                }
              >
                {s.label}
              </button>
            ))}
            {pFiltering && (
              <button
                type="button"
                onClick={() => {
                  setPQuery("");
                  setPTag("");
                  setPStatus("");
                }}
                className="rounded-full px-2 py-1 text-[12px] font-semibold text-[var(--hob-faint)] hover:text-[var(--hob-ink)]"
              >
                ✕ ניקוי
              </button>
            )}
          </div>
        )}
        <form
          className="mb-2 flex flex-wrap items-center gap-1.5"
          onSubmit={(ev) => {
            ev.preventDefault();
            if (seeds.trim()) act.mutate({ action: "seed_handles", handles: seeds });
            setSeeds("");
          }}
        >
          <input value={seeds} onChange={(ev) => setSeeds(ev.target.value)} placeholder="ידיות לבדיקה של ליה בריצה הבאה (למשל @noa.agam, @someone)" dir="ltr" className="min-w-[240px] flex-1 rounded-md border border-[var(--hob-rule)] bg-[var(--hob-bg)] px-2 py-1 text-[12px] text-[var(--hob-ink)] outline-none" />
          <button type="submit" className="rounded-md border border-[var(--hob-rule)] px-2.5 py-1 text-[12px] font-semibold text-[var(--hob-ink)] hover:bg-[var(--hob-hover)]">שמור לבדיקה</button>
        </form>
        {prospects.length === 0 && (
          <div className="py-5 text-center text-[13px] text-[var(--hob-faint)]">
            אין עדיין מועמדים. ליה מוסיפה עד 5 בשבוע, אחרי אימות מול אינסטגרם.
          </div>
        )}
        {pFiltering && visibleProspects.length === 0 && activeProspects.length > 0 && (
          <div className="py-4 text-center text-[13px] text-[var(--hob-faint)]">
            אין תוצאות לסינון הזה
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          {visibleProspects.map((p) => {
            const st = PSTATUS.find((x) => x.key === p.status) ?? PSTATUS[0];
            const next = PSTATUS.find((x) => x.key === NEXT[p.status]);
            const prevKey = p.status === "received" ? (p.shoot ? "shoot_set" : p.package_sent_at ? "package_sent" : "agreed") : PREV[p.status];
            const prevP = PSTATUS.find((x) => x.key === prevKey);
            const overdue = p.followup_date && p.followup_date <= new Date().toISOString().slice(0, 10) && !["done", "rejected", "candidate"].includes(p.status);
            const open = openCard === p.id;
            return (
              <div
                key={p.id}
                className="group flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-[var(--hob-rule)] px-3 py-2"
              >
                <span className="text-[13.5px] font-semibold text-[var(--hob-ink)]">
                  {p.name}
                </span>
                {p.instagram && (
                  <a
                    href={`https://instagram.com/${p.instagram}`}
                    target="_blank"
                    rel="noopener"
                    dir="ltr"
                    className="text-[12.5px] text-[#0073ea] hover:underline"
                  >
                    @{p.instagram}
                  </a>
                )}
                <span className="rounded-md bg-[var(--hob-hover)] px-2 py-0.5 text-[11.5px] font-bold text-[var(--hob-ink)] [font-variant-numeric:tabular-nums]">
                  {fmtFollowers(p.followers)}
                </span>
                {p.niche && (
                  <span className="text-[11.5px] text-[var(--hob-faint)]">{p.niche}</span>
                )}
                {p.note && (
                  <span className="max-w-[340px] truncate text-[11.5px] text-[var(--hob-faint)]" title={p.note}>
                    {p.note}
                  </span>
                )}
                {p.verdict && <span className="text-[11px]" title={p.verdict_reason}>{p.verdict === "fit" ? "✅" : p.verdict === "not_fit" ? "⛔" : "⏳"}</span>}
                {overdue && <span className="rounded-md bg-[#e2445c]/15 px-1.5 py-0.5 text-[11px] font-semibold text-[#e2445c]">מעקב עבר</span>}
                {!overdue && p.followup_date && !["done", "rejected"].includes(p.status) && <span className="text-[11px] text-[var(--hob-faint)]">מעקב {p.followup_date.slice(5)}</span>}
                <button type="button" onClick={() => setOpenCard(open ? null : p.id)} className="rounded-md border border-[var(--hob-rule)] px-1.5 py-0.5 text-[11.5px] text-[var(--hob-ink)] hover:bg-[var(--hob-hover)]">{open ? "סגור" : "פרטים"}</button>
                <span className="ms-auto flex items-center gap-1.5">
                  {p.status !== "linked" && p.status !== "rejected" && (
                    <button
                      type="button"
                      onClick={() =>
                        act.mutate({ action: "prospect_link", id: p.id, campaignId: campaign.id })
                      }
                      className="rounded-md border border-[var(--hob-rule)] px-2.5 py-1 text-[12px] font-semibold text-[var(--hob-ink)] hover:bg-[var(--hob-hover)]"
                    >
                      יצירת לינק
                    </button>
                  )}
                  {p.status === "linked" &&
                    (() => {
                      // The link is born at the top of the page — hand its URL
                      // right here so promoting never feels like a dead click.
                      const pl = links.find((l) => l.id === p.link_id);
                      if (!pl) return null;
                      return (
                        <button
                          type="button"
                          title={pageURL(pl.token)}
                          onClick={async () => {
                            try {
                              await navigator.clipboard.writeText(pageURL(pl.token));
                              setCopied(200000 + p.id);
                              setTimeout(() => setCopied(null), 1600);
                            } catch {
                              // URL visible in the title anyway
                            }
                          }}
                          className="rounded-md bg-[#00a359] px-2.5 py-1 text-[12px] font-bold text-white hover:opacity-90"
                        >
                          {copied === 200000 + p.id ? "הועתק ✓" : "📋 העתקת הדף האישי"}
                        </button>
                      );
                    })()}
                  {armArchive === p.id ? (
                    <button
                      type="button"
                      onClick={() => {
                        setArmArchive(null);
                        act.mutate({ action: "prospect_status", id: p.id, status: "rejected" });
                      }}
                      onBlur={() => setArmArchive(null)}
                      className="rounded-md bg-[#e2445c] px-2 py-1 text-[12px] font-bold text-white"
                    >
                      לארכיון?
                    </button>
                  ) : (
                    <button
                      type="button"
                      title="לארכיון — נשמרת ברשימה כחסימת כפילויות, אפשר לשחזר"
                      onClick={() => setArmArchive(p.id)}
                      className="rounded-md border border-[var(--hob-rule)] px-1.5 py-1 text-[12px] text-[var(--hob-faint)] hover:bg-[var(--hob-hover)]"
                    >
                      🗄️
                    </button>
                  )}
                  {prevP && (
                    <button
                      type="button"
                      title={`צעד אחורה: ${prevP.label}`}
                      onClick={() =>
                        act.mutate({ action: "prospect_status", id: p.id, status: prevP.key, version: p.version })
                      }
                      className="rounded-md border border-[var(--hob-rule)] px-1.5 py-1 text-[12px] text-[var(--hob-faint)] hover:bg-[var(--hob-hover)]"
                    >
                      ↩
                    </button>
                  )}
                  <button
                    type="button"
                    title={next ? `מעבר ל: ${next.label}` : p.status === "scheduled" ? "רשומה ישנה: פתח פרטים ובחר מה קרה בפועל" : st.label}
                    disabled={!next || p.status === "linked"}
                    onClick={() => next && act.mutate({ action: "prospect_status", id: p.id, status: next.key, version: p.version })}
                    className="rounded-md px-2.5 py-1 text-[12px] font-bold text-white disabled:opacity-70"
                    style={{ backgroundColor: st.bg }}
                  >
                    {st.label}
                  </button>
                  <DeleteButton
                    onConfirm={() => act.mutate({ action: "delete_prospect", id: p.id })}
                  />
                </span>
                {open && <ProspectCard p={p} act={(body) => act.mutate(body)} />}
              </div>
            );
          })}
        </div>
        {prospects.some((p) => p.status === "rejected") && (
          <details className="mt-3">
            <summary className="cursor-pointer text-[12.5px] font-semibold text-[var(--hob-faint)]">
              🗄️ ארכיון ({prospects.filter((p) => p.status === "rejected").length}) — נשמרים כדי שלא ניצור כפילויות
            </summary>
            <div className="mt-2 flex flex-col gap-1">
              {prospects
                .filter((p) => p.status === "rejected")
                .map((p) => (
                  <div
                    key={p.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-[var(--hob-rule)] px-3 py-1.5 opacity-60"
                  >
                    <span className="text-[12.5px] font-semibold text-[var(--hob-ink)]">
                      {p.name}
                    </span>
                    {p.instagram && (
                      <span dir="ltr" className="text-[11.5px] text-[var(--hob-faint)]">
                        @{p.instagram}
                      </span>
                    )}
                    <span className="text-[11px] text-[var(--hob-faint)]">
                      {fmtFollowers(p.followers)}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        act.mutate({ action: "prospect_status", id: p.id, status: "to_contact" })
                      }
                      className="ms-auto rounded-md border border-[var(--hob-rule)] px-2 py-0.5 text-[11.5px] text-[var(--hob-ink)] hover:bg-[var(--hob-hover)]"
                    >
                      החזרה לרשימה
                    </button>
                  </div>
                ))}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}
