import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { PARTNER, PARTNERS, isPartner } from "../../lib/partners";
import { DeleteButton, EditableText, api, parseMoney, post } from "./board";
import { nis } from "./money";
import { ProspectCard } from "./prospect-card";
import { toast } from "./toast";

// ---- 🤝 משפיענים: the influencer collab tab ----
//
// Personal invite links (/c/<token>), who signed up through them, each signup
// through the pipeline (ממתינה → מאושרת → נשלח מוצר → פרסמה → הסתיים), the
// sales leaderboard, and the outreach list kept by hand. Every link and
// prospect carries "who handles her" (אביה / ליאור); the chip row at the top
// filters the whole tab by that.

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
  gender: string;
  commission_paid: number;
  combines_ok: number;
  code_ended_at: string;
  handled_by: string;
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
  next_step: string;
  followup_date: string;
  size: string;
  log: string;
  handled_by: string;
  created_at: string;
};

type Settings = {
  base: string;
  storeUrl: string;
  discountPct: number;
  commissionPct: number;
  instagram: string;
  brandName: string;
};

type CollabData = {
  ok: boolean;
  me: string;
  settings: Settings;
  campaign: Campaign;
  products: Product[];
  links: Link[];
  signups: Signup[];
  prospects: Prospect[];
};

// Outreach ladder: the colored button advances one step; ↩ goes back.
const PSTATUS: { key: string; label: string; bg: string }[] = [
  { key: "candidate", label: "מועמדת", bg: "#fdab3d" },
  { key: "to_contact", label: "לפנות", bg: "#676879" },
  { key: "contacted", label: "נשלחה פנייה", bg: "#0073ea" },
  { key: "talking", label: "ענתה", bg: "#a25ddc" },
  { key: "agreed", label: "סוכמו תנאים", bg: "#7e3af2" },
  { key: "package_sent", label: "חבילה נשלחה", bg: "#0086c0" },
  { key: "received", label: "התקבל תוכן", bg: "#00a359" },
  { key: "done", label: "הושלם", bg: "#037f4c" },
  { key: "linked", label: "נוצר לינק", bg: "#00a359" },
  { key: "rejected", label: "לארכיון", bg: "#e2445c" },
];
const NEXT: Record<string, string> = {
  candidate: "to_contact",
  to_contact: "contacted",
  contacted: "talking",
  talking: "agreed",
  agreed: "package_sent",
  package_sent: "received",
  received: "done",
};
const PREV: Record<string, string> = {
  to_contact: "candidate",
  contacted: "to_contact",
  talking: "contacted",
  agreed: "talking",
  package_sent: "agreed",
  received: "package_sent",
  done: "received",
};

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

// Public-facing links use the domain from settings (collab_domain), with the
// request origin as the fallback — a workers.dev URL reads like phishing in a
// DM, so the partners set the real domain once and the tab follows.
function pageURL(s: Settings, token: string): string {
  return `${s.base}/c/${token}`;
}
function saleURL(s: Settings, code: string): string {
  return `${s.base}/s/${code}`;
}
function myURL(s: Settings, token: string): string {
  return `${s.base}/my/${token}`;
}

// The "you're in" WhatsApp: her code, what it gives, her share link, her
// stats page, and the next step — one tap after approving.
function waApproveURL(
  s: Settings,
  su: { full_name: string; phone: string },
  code: string,
  token: string,
): string {
  const first = su.full_name.trim().split(/\s+/)[0] || su.full_name;
  const digits = su.phone.replace(/\D/g, "").replace(/^0/, "972");
  const tag = s.instagram ? `@${s.instagram}` : s.brandName;
  const msg =
    `היי ${first}! התקבלת לשיתוף הפעולה עם ${s.brandName} 🖤\n` +
    `הקוד האישי שלך: ${code}\n` +
    `הוא נותן לעוקבים שלך ${s.discountPct}% הנחה על כל החנות, ומכל הזמנה שנכנסת איתו מגיעים לך ${s.commissionPct}%.\n` +
    `הלינק שלך לשיתוף: ${saleURL(s, code)}\n` +
    `הדף האישי שלך, עם כל ההזמנות והעמלות בזמן אמת: ${myURL(s, token)}\n` +
    `המוצר בדרך אליך! אחרי שהוא מגיע: רילס תוך 10 ימים עם תיוג ${tag}. לכל שאלה אנחנו כאן 🙏`;
  return `https://wa.me/${digits}?text=${encodeURIComponent(msg)}`;
}

function waShareURL(s: Settings, l: Link): string {
  const first = l.name.trim().split(/\s+/)[0] || l.name;
  const msg =
    `היי ${first}! כאן ${s.brandName} 🖤\n` +
    `אנחנו מזמינות אותך לשתף איתנו פעולה. הכנו לך עמוד אישי עם כל הפרטים:\n` +
    pageURL(s, l.token);
  return `https://wa.me/?text=${encodeURIComponent(msg)}`;
}

// Who handles her: a small pill that cycles — → אביה → ליאור → —.
function WhoPill({
  value,
  onChange,
  small,
}: {
  value: string;
  onChange: (next: string) => void;
  small?: boolean;
}) {
  const next = value === "" ? PARTNERS[0] : value === PARTNERS[0] ? PARTNERS[1] : "";
  const p = isPartner(value) ? PARTNER[value] : null;
  return (
    <button
      type="button"
      title={p ? `מטופלת על ידי ${p.label} · לחיצה מחליפה` : "מי מטפלת? לחיצה לבחירה"}
      onClick={() => onChange(next)}
      className={`rounded-full border font-bold ${small ? "h-5 min-w-5 px-1.5 text-[10.5px]" : "h-6 min-w-6 px-2 text-[11.5px]"}`}
      style={
        p
          ? { backgroundColor: p.color, borderColor: p.color, color: "#fff" }
          : { borderColor: "var(--hob-rule)", color: "var(--hob-faint)" }
      }
    >
      {p ? p.letter : "—"}
    </button>
  );
}

// Ending a collaboration takes two taps, because the code stops working for
// all her followers at once. The code is never deleted — the commission she
// earned and the orders already attributed stay put.
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

const WHO_KEY = "hob_collab_who";

export function InfluencersView({ onAuthLost }: { onAuthLost: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [insta, setInsta] = useState("");
  const [linkGender, setLinkGender] = useState("");
  const [linkWho, setLinkWho] = useState<string | null>(null);
  // "0:N" = they pick N items from stock themselves; a number = fixed product
  const [productSel, setProductSel] = useState<string>("0:1");
  const [copied, setCopied] = useState<number | null>(null);
  // Tab-wide filter: whose influencers to show. Remembered per browser.
  const [who, setWho] = useState<string>(() => {
    try {
      return localStorage.getItem(WHO_KEY) ?? "";
    } catch {
      return "";
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(WHO_KEY, who);
    } catch {
      // per-browser convenience only
    }
  }, [who]);
  // Prospect list controls: free-text search + one status chip, ANDed.
  const [pQuery, setPQuery] = useState("");
  const [pStatus, setPStatus] = useState<string>("");
  const [armArchive, setArmArchive] = useState<number | null>(null);
  const [openCard, setOpenCard] = useState<number | null>(null);
  // New prospect form
  const [np, setNp] = useState({ name: "", instagram: "", followers: "", niche: "", note: "", gender: "" });
  const [npOpen, setNpOpen] = useState(false);

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
    onSuccess: (res) => {
      const r = (res ?? {}) as { ok?: boolean; error?: string; duplicate?: boolean };
      if (r.ok === false) toast(r.error || "לא נשמר", "error");
      else if (r.duplicate) toast("היא כבר ברשימה (או בארכיון)", "error");
    },
    onError: () => toast("לא נשמר. בדקו חיבור ונסו שוב", "error"),
    onSettled: invalidate,
  });

  const me = q.data?.me ?? "";
  const settings: Settings = q.data?.settings ?? {
    base: "",
    storeUrl: "",
    discountPct: 10,
    commissionPct: 10,
    instagram: "",
    brandName: "",
  };
  const rate = settings.commissionPct / 100;
  const campaign = q.data?.campaign ?? null;
  const products = q.data?.products ?? [];
  const allLinks = q.data?.links ?? [];
  const allProspects = q.data?.prospects ?? [];
  const allSignups = q.data?.signups ?? [];

  // The chip row filters everything below it. A signup follows its link.
  const links = who ? allLinks.filter((l) => l.handled_by === who) : allLinks;
  const linkIds = new Set(links.map((l) => l.id));
  const signups = who ? allSignups.filter((s) => s.link_id != null && linkIds.has(s.link_id)) : allSignups;
  const prospects = who ? allProspects.filter((p) => p.handled_by === who) : allProspects;

  const activeProspects = prospects.filter((p) => p.status !== "rejected");
  const pNeedle = pQuery.trim().toLowerCase();
  const visibleProspects = activeProspects.filter((p) => {
    if (pStatus && p.status !== pStatus) return false;
    if (pNeedle && !`${p.name} ${p.instagram} ${p.niche} ${p.note}`.toLowerCase().includes(pNeedle))
      return false;
    return true;
  });
  const pFiltering = !!(pStatus || pNeedle);

  const copyText = async (text: string, key: number) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(null), 1600);
    } catch {
      // Clipboard can be blocked — the URL is visible in the row anyway.
    }
  };

  if (q.isLoading) {
    return <div className="py-24 text-center text-[var(--hob-faint)]">טוענת משפיענים…</div>;
  }
  if (!campaign) {
    return (
      <div className="py-24 text-center text-[var(--hob-faint)]">
        לא הצלחתי לטעון את הקמפיין. נסו לרענן.
      </div>
    );
  }

  const card = "rounded-xl border border-[var(--hob-rule)] bg-[var(--hob-surface)] p-4";
  const input =
    "w-full rounded-lg border border-[var(--hob-rule)] bg-[var(--hob-bg)] px-3 py-2 text-[14px] text-[var(--hob-ink)] outline-none focus:border-[var(--hob-ink)]";
  const chip = (on: boolean, color?: string) =>
    `rounded-full border px-3 py-1 text-[12.5px] font-semibold ${
      on
        ? "text-white"
        : "border-[var(--hob-rule)] text-[var(--hob-ink)] hover:bg-[var(--hob-hover)]"
    }`;
  const chipStyle = (on: boolean, color: string) =>
    on ? { backgroundColor: color, borderColor: color } : undefined;
  const newLinkWho = linkWho ?? me;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-3 py-5">
      {/* Who: the tab-wide filter */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="me-1 text-[12.5px] text-[var(--hob-faint)]">מי מטפלת:</span>
        <button type="button" onClick={() => setWho("")} className={chip(who === "")} style={chipStyle(who === "", "var(--hob-ink)")}>
          הכל
        </button>
        {PARTNERS.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setWho(who === k ? "" : k)}
            className={chip(who === k)}
            style={chipStyle(who === k, PARTNER[k].color)}
          >
            {PARTNER[k].label}
          </button>
        ))}
        {who && (
          <span className="text-[11.5px] text-[var(--hob-faint)]">
            · {links.length} לינקים · {activeProspects.length} ברשימה
          </span>
        )}
      </div>

      {/* Campaign settings — what the public page shows, editable in place */}
      <div className={card}>
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="flex items-center gap-1.5 text-[15px] font-extrabold text-[var(--hob-ink)]">
            🤝
            <EditableText
              value={campaign.title}
              className="text-[15px] font-extrabold text-[var(--hob-ink)]"
              onSave={(v) => v.trim() && act.mutate({ action: "update_campaign", id: campaign.id, title: v })}
            />
          </h2>
          <span className="text-[12px] text-[var(--hob-faint)]">מה שכתוב כאן מופיע בעמוד הציבורי</span>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-6">
          <div className="flex items-center gap-2">
            <span className="text-[12.5px] text-[var(--hob-faint)]">מוצר:</span>
            <EditableText
              value={campaign.product_name}
              placeholder="הפריט שמציעות (כשלא בוחרות מהמלאי)"
              className="text-[13.5px] font-semibold text-[var(--hob-ink)]"
              onSave={(v) => act.mutate({ action: "update_campaign", id: campaign.id, product_name: v })}
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
                if (Number.isFinite(n) && n >= 0)
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
        <p className="mt-2 text-[11.5px] text-[var(--hob-faint)]">
          {settings.discountPct}% הנחה לקונה · {settings.commissionPct}% עמלה למשפיענית · הלינקים על{" "}
          <span dir="ltr">{settings.base || "(אין דומיין)"}</span>
          {settings.storeUrl ? "" : " · לא הוגדרה כתובת חנות (store_url) — לינק המכירה לא יעבוד"}
          {" · "}משנים בהגדרות
        </p>
      </div>

      {/* Funnel */}
      {links.length > 0 && (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          {(() => {
            const opened = links.filter((l) => l.views > 0 || l.signups > 0).length;
            const approved = signups.filter((x) => x.status !== "pending").length;
            const posted = signups.filter((x) => x.status === "posted" || x.status === "done").length;
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
        <h3 className="mb-3 text-[14px] font-extrabold text-[var(--hob-ink)]">＋ לינק אישי חדש</h3>
        <form
          className="flex flex-col gap-2 sm:flex-row sm:flex-wrap"
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
              handled_by: newLinkWho,
            });
            setName("");
            setInsta("");
          }}
        >
          <input className={input + " sm:flex-1"} placeholder="שם (נועה כהן)" value={name} onChange={(e) => setName(e.target.value)} />
          <input
            className={input + " sm:flex-1"}
            placeholder="אינסטגרם בלי @ (noa.example)"
            dir="ltr"
            value={insta}
            onChange={(e) => setInsta(e.target.value)}
          />
          <select
            className={input + " sm:w-auto"}
            value={linkGender}
            onChange={(e) => setLinkGender(e.target.value)}
            title="קובע את הפנייה בעמוד האישי"
          >
            <option value="">פנייה נייטרלית</option>
            <option value="f">בחורה</option>
            <option value="m">בחור</option>
          </select>
          <select className={input + " sm:w-auto"} value={productSel} onChange={(e) => setProductSel(e.target.value)}>
            <option value="0:1">✨ בוחרות בעצמן מהמלאי · פריט אחד</option>
            <option value="0:2">✨ בוחרות בעצמן מהמלאי · 2 פריטים</option>
            <option value="0:3">✨ בוחרות בעצמן מהמלאי · 3 פריטים</option>
            {products.map((pr) => (
              <option key={pr.id} value={`${pr.id}:1`}>
                {pr.name} · ₪{pr.value}
              </option>
            ))}
          </select>
          <select
            className={input + " sm:w-auto"}
            value={newLinkWho}
            onChange={(e) => setLinkWho(e.target.value)}
            title="מי מטפלת במשפיענית הזאת"
          >
            <option value="">מי מטפלת?</option>
            {PARTNERS.map((k) => (
              <option key={k} value={k}>
                {PARTNER[k].label}
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
                <WhoPill value={l.handled_by} onChange={(next) => act.mutate({ action: "set_handled_by", kind: "link", id: l.id, who: next })} />
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
                    ? `✨ לבחירתה${l.picks > 1 ? ` · עד ${l.picks} פריטים` : ""}`
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
                    onClick={() => copyText(saleURL(settings, l.discount_code), -l.id)}
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
                {/* A code minted without store combinations cancels the
                    store's automatic discounts instead of joining them. The
                    button disappears once the store confirms the fix. */}
                {l.discount_code && !l.combines_ok && !l.code_ended_at && (
                  <button
                    type="button"
                    title="הקוד נוצר בלי שילוב הנחות: בעגלה עם הנחה אוטומטית הוא מבטל אותה במקום להצטרף אליה. תיקון בחנות, הקוד עצמו לא משתנה."
                    onClick={() => act.mutate({ action: "fix_combinations", id: l.id })}
                    className="rounded-md border border-[#e8a13a] bg-[#e8a13a]/10 px-2 py-0.5 text-[11.5px] font-semibold text-[#e8a13a]"
                  >
                    ⚠️ מתנגש עם הנחות — לתקן
                  </button>
                )}
                {l.discount_code && !l.is_generic && !l.code_ended_at && (
                  <EndCodeButton
                    name={l.name}
                    onConfirm={() => act.mutate({ action: "set_code_active", id: l.id, active: false })}
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
                    onClick={() => copyText(myURL(settings, l.token), 100000 + l.id)}
                    className="rounded-md bg-[var(--hob-hover)] px-2 py-0.5 text-[11.5px] font-bold text-[var(--hob-ink)]"
                  >
                    {copied === 100000 + l.id ? "הועתק ✓" : "📊 דף אישי"}
                  </button>
                ) : null}
                <span
                  className={`text-[11.5px] font-bold ${
                    l.signups > 0 ? "text-[#00a359]" : l.views > 0 ? "text-[#e8a13a]" : "text-[var(--hob-faint)]"
                  }`}
                >
                  {l.signups > 0 ? "✓ נרשמה" : l.views > 0 ? `נפתח ${l.views}× · לא נרשמה` : "לא נפתח עדיין"}
                </span>
                <span className="ms-auto flex items-center gap-1">
                  <a
                    href={waShareURL(settings, l)}
                    target="_blank"
                    rel="noopener"
                    className="rounded-md bg-[#25D366] px-2.5 py-1 text-[12px] font-bold text-white hover:opacity-90"
                  >
                    שליחה בווצאפ
                  </a>
                  <button
                    type="button"
                    onClick={() => copyText(pageURL(settings, l.token), l.id)}
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
        {links.length === 0 && allLinks.length > 0 && (
          <div className="mt-3 text-center text-[12.5px] text-[var(--hob-faint)]">אין לינקים בסינון הזה</div>
        )}
      </div>

      {/* Sales leaderboard */}
      {links.some((l) => l.discount_code || l.sales_count > 0) && (
        <div className={card}>
          <h3 className="mb-1 text-[14px] font-extrabold text-[var(--hob-ink)]">💸 ליגת המכירות</h3>
          <p className="mb-3 text-[12px] text-[var(--hob-faint)]">
            {settings.discountPct}% הנחה לקונה · {settings.commissionPct}% עמלה למשפיענית · הזמנה עם הקוד שלה נזקפת לה אוטומטית
          </p>
          <div className="flex flex-col gap-1.5">
            {links
              .filter((l) => l.discount_code || l.sales_count > 0)
              .sort((a, b) => b.sales_total - a.sales_total)
              .map((l, idx) => {
                const accrued = l.sales_total * rate;
                const due = accrued - (l.commission_paid || 0);
                return (
                  <div
                    key={l.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-[var(--hob-rule)] px-3 py-2"
                  >
                    <span className="w-5 text-center text-[13px] font-bold text-[var(--hob-faint)]">{idx + 1}</span>
                    <span className="text-[13.5px] font-semibold text-[var(--hob-ink)]">{l.name}</span>
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
                        עמלה <span className="dm">{nis(accrued)}</span>
                      </span>
                      {accrued <= 0 ? null : due > 0.5 ? (
                        <button
                          type="button"
                          title="סימון שהעמלה הפתוחה שולמה לה"
                          onClick={() => act.mutate({ action: "commission_paid", linkId: l.id })}
                          className="rounded-md border border-[#e8a13a] px-2 py-1 text-[12px] font-bold text-[#e8a13a] hover:bg-[#e8a13a] hover:text-white"
                        >
                          לתשלום <span className="dm">{nis(due)}</span> · ✓ שולם
                        </button>
                      ) : (
                        <span className="text-[11.5px] font-bold text-[var(--hob-faint)]">✓ שולם הכל</span>
                      )}
                    </span>
                  </div>
                );
              })}
          </div>
        </div>
      )}

      {/* Signups */}
      <div className={card}>
        <h3 className="mb-3 text-[14px] font-extrabold text-[var(--hob-ink)]">הרשמות ({signups.length})</h3>
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
            const link = allLinks.find((l) => l.id === s.link_id);
            return (
              <div
                key={s.id}
                className="group flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-[var(--hob-rule)] px-3 py-2.5"
              >
                {link && (
                  <WhoPill
                    small
                    value={link.handled_by}
                    onChange={(n) => act.mutate({ action: "set_handled_by", kind: "link", id: link.id, who: n })}
                  />
                )}
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
                {s.product && <span className="text-[12px] font-semibold text-[var(--hob-faint)]">{s.product}</span>}
                {(s.size || s.color) && (
                  <span className="rounded-md bg-[var(--hob-hover)] px-2 py-0.5 text-[12px] font-bold text-[var(--hob-ink)]">
                    {[s.size, s.color].filter(Boolean).join(" · ")}
                  </span>
                )}
                <span className="text-[12.5px] text-[var(--hob-faint)]">
                  {s.address}
                  {s.is_private ? " (בית פרטי)" : `${s.floor ? ` קומה ${s.floor}` : ""}${s.apt ? ` דירה ${s.apt}` : ""}`}, {s.city}
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
                      <a href={s.reel_url} target="_blank" rel="noopener" className="font-bold text-[#a25ddc] hover:underline">
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
                        if (Number.isFinite(n)) act.mutate({ action: "update_reel", id: s.id, reel_views: n });
                      }}
                    />
                    <button
                      type="button"
                      title="קיבלנו ממנה את קובץ הווידאו המקורי (זכויות שימוש בפרסום)"
                      onClick={() => act.mutate({ action: "file_received", id: s.id, value: !s.file_received })}
                      className={
                        s.file_received
                          ? "rounded-md bg-[#a25ddc] px-2 py-0.5 text-[11.5px] font-bold text-white"
                          : "rounded-md border border-[var(--hob-rule)] px-2 py-0.5 text-[11.5px] text-[var(--hob-faint)] hover:bg-[var(--hob-hover)]"
                      }
                    >
                      {s.file_received ? "🎬 קובץ אצלנו" : "＋ קובץ מקורי"}
                    </button>
                  </span>
                )}
                <span className="ms-auto flex items-center gap-1.5">
                  {s.status === "pending" ? (
                    <>
                      <span className="rounded-md bg-[#e8a13a] px-2.5 py-1 text-[12px] font-bold text-white">⏳ ממתינה לאישור</span>
                      <button
                        type="button"
                        onClick={() => act.mutate({ action: "update_status", id: s.id, status: "signed" })}
                        className="rounded-md bg-[#00a359] px-2.5 py-1 text-[12px] font-bold text-white hover:opacity-90"
                      >
                        ✓ אישור
                      </button>
                      <DeleteButton onConfirm={() => act.mutate({ action: "delete_signup", id: s.id })} />
                    </>
                  ) : (
                    <>
                      {link && link.discount_code && s.phone ? (
                        <a
                          href={waApproveURL(settings, s, link.discount_code, link.token)}
                          target="_blank"
                          rel="noopener"
                          title="ווצאפ מוכן: התקבלת + הקוד + לינק השיתוף + הצעד הבא"
                          className="rounded-md bg-[#25D366] px-2.5 py-1 text-[12px] font-bold text-white hover:opacity-90"
                        >
                          📲 הודעת אישור
                        </a>
                      ) : null}
                      {prev && (
                        <button
                          type="button"
                          title={`צעד אחורה: ${prev.label}`}
                          onClick={() => act.mutate({ action: "update_status", id: s.id, status: prev.key })}
                          className="rounded-md border border-[var(--hob-rule)] px-1.5 py-1 text-[12px] text-[var(--hob-faint)] hover:bg-[var(--hob-hover)]"
                        >
                          ↩
                        </button>
                      )}
                      <button
                        type="button"
                        title={`מעבר לסטטוס הבא: ${next.label}`}
                        onClick={() => act.mutate({ action: "update_status", id: s.id, status: next.key })}
                        className="rounded-md px-2.5 py-1 text-[12px] font-bold text-white"
                        style={{ backgroundColor: st.bg }}
                      >
                        {st.label}
                      </button>
                      <DeleteButton onConfirm={() => act.mutate({ action: "delete_signup", id: s.id })} />
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
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[14px] font-extrabold text-[var(--hob-ink)]">
            🎯 רשימת פניות ({pFiltering ? `${visibleProspects.length} מתוך ${activeProspects.length}` : activeProspects.length})
          </h3>
          <button
            type="button"
            onClick={() => setNpOpen((v) => !v)}
            className="rounded-md border border-[var(--hob-rule)] px-2.5 py-1 text-[12px] font-semibold text-[var(--hob-ink)] hover:bg-[var(--hob-hover)]"
          >
            {npOpen ? "סגירה" : "＋ הוספה לרשימה"}
          </button>
        </div>
        <p className="mb-3 text-[12px] text-[var(--hob-faint)]">
          לחיצה על הסטטוס מקדמת אותו · "יצירת לינק" הופכת מועמדת למשפיענית פעילה
        </p>
        {npOpen && (
          <form
            className="mb-3 grid grid-cols-2 gap-2 rounded-lg border border-dashed border-[var(--hob-rule)] p-3 sm:grid-cols-3"
            onSubmit={(ev) => {
              ev.preventDefault();
              if (!np.name.trim()) return;
              act.mutate({
                action: "add_prospect",
                name: np.name.trim(),
                instagram: np.instagram.trim(),
                followers: Number(np.followers.replace(/[^\d]/g, "")) || 0,
                niche: np.niche.trim(),
                note: np.note.trim(),
                gender: np.gender,
                handled_by: who || me,
              });
              setNp({ name: "", instagram: "", followers: "", niche: "", note: "", gender: "" });
            }}
          >
            <input className={input} placeholder="שם" value={np.name} onChange={(e) => setNp({ ...np, name: e.target.value })} />
            <input className={input} placeholder="אינסטגרם בלי @" dir="ltr" value={np.instagram} onChange={(e) => setNp({ ...np, instagram: e.target.value })} />
            <input className={input} placeholder="עוקבים (12000)" inputMode="numeric" value={np.followers} onChange={(e) => setNp({ ...np, followers: e.target.value })} />
            <input className={input} placeholder="נישה (אופנה, לייף סטייל)" value={np.niche} onChange={(e) => setNp({ ...np, niche: e.target.value })} />
            <select className={input} value={np.gender} onChange={(e) => setNp({ ...np, gender: e.target.value })}>
              <option value="">מגדר (רשות)</option>
              <option value="f">בחורה</option>
              <option value="m">בחור</option>
            </select>
            <input className={input} placeholder="הערה" value={np.note} onChange={(e) => setNp({ ...np, note: e.target.value })} />
            <div className="col-span-2 flex items-center justify-between gap-2 sm:col-span-3">
              <span className="text-[11.5px] text-[var(--hob-faint)]">
                תטופל על ידי {isPartner(who || me) ? PARTNER[(who || me) as "avia" | "lior"].label : "— (אפשר לשנות בשורה)"}
              </span>
              <button
                type="submit"
                disabled={!np.name.trim() || act.isPending}
                className="rounded-lg bg-[var(--hob-ink)] px-4 py-1.5 text-[13px] font-bold text-[var(--hob-bg)] disabled:opacity-50"
              >
                הוספה
              </button>
            </div>
          </form>
        )}
        {activeProspects.length > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-1.5">
            <input
              value={pQuery}
              onChange={(e) => setPQuery(e.target.value)}
              placeholder="חיפוש שם / @ / נישה"
              className="h-8 w-full max-w-[240px] rounded-md border border-[var(--hob-rule)] bg-transparent px-2.5 text-[12.5px] text-[var(--hob-ink)] placeholder:text-[var(--hob-faint)] focus:outline-none"
            />
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
                  setPStatus("");
                }}
                className="rounded-full px-2 py-1 text-[12px] font-semibold text-[var(--hob-faint)] hover:text-[var(--hob-ink)]"
              >
                ✕ ניקוי
              </button>
            )}
          </div>
        )}
        {activeProspects.length === 0 && (
          <div className="py-5 text-center text-[13px] text-[var(--hob-faint)]">
            {allProspects.length && who ? "אין ברשימה של " + (isPartner(who) ? PARTNER[who].label : "") : "הרשימה ריקה. הוסיפו את מי שרוצות לפנות אליהן."}
          </div>
        )}
        {pFiltering && visibleProspects.length === 0 && activeProspects.length > 0 && (
          <div className="py-4 text-center text-[13px] text-[var(--hob-faint)]">אין תוצאות לסינון הזה</div>
        )}
        <div className="flex flex-col gap-1.5">
          {visibleProspects.map((p) => {
            const st = PSTATUS.find((x) => x.key === p.status) ?? PSTATUS[0];
            const next = PSTATUS.find((x) => x.key === NEXT[p.status]);
            const prevP = PSTATUS.find((x) => x.key === PREV[p.status]);
            const today = new Date().toISOString().slice(0, 10);
            const overdue = !!p.followup_date && p.followup_date <= today && !["done", "rejected", "linked"].includes(p.status);
            const open = openCard === p.id;
            return (
              <div
                key={p.id}
                className="group flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-[var(--hob-rule)] px-3 py-2"
              >
                <WhoPill value={p.handled_by} onChange={(n) => act.mutate({ action: "set_handled_by", kind: "prospect", id: p.id, who: n })} />
                <span className="text-[13.5px] font-semibold text-[var(--hob-ink)]">{p.name}</span>
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
                {p.followers > 0 && (
                  <span className="rounded-md bg-[var(--hob-hover)] px-2 py-0.5 text-[11.5px] font-bold text-[var(--hob-ink)] [font-variant-numeric:tabular-nums]">
                    {fmtFollowers(p.followers)}
                  </span>
                )}
                {p.niche && <span className="text-[11.5px] text-[var(--hob-faint)]">{p.niche}</span>}
                {p.note && (
                  <span className="max-w-[340px] truncate text-[11.5px] text-[var(--hob-faint)]" title={p.note}>
                    {p.note}
                  </span>
                )}
                {p.next_step && !open && (
                  <span className="max-w-[260px] truncate text-[11.5px] text-[var(--hob-soft)]" title={p.next_step}>
                    → {p.next_step}
                  </span>
                )}
                {overdue && <span className="rounded-md bg-[#e2445c]/15 px-1.5 py-0.5 text-[11px] font-semibold text-[#e2445c]">מעקב עבר</span>}
                {!overdue && p.followup_date && !["done", "rejected"].includes(p.status) && (
                  <span className="text-[11px] text-[var(--hob-faint)]">מעקב {p.followup_date.slice(8, 10)}/{p.followup_date.slice(5, 7)}</span>
                )}
                <button
                  type="button"
                  onClick={() => setOpenCard(open ? null : p.id)}
                  className="rounded-md border border-[var(--hob-rule)] px-1.5 py-0.5 text-[11.5px] text-[var(--hob-ink)] hover:bg-[var(--hob-hover)]"
                >
                  {open ? "סגירה" : "פרטים"}
                </button>
                <span className="ms-auto flex items-center gap-1.5">
                  {p.status !== "linked" && p.status !== "rejected" && (
                    <button
                      type="button"
                      onClick={() => act.mutate({ action: "prospect_link", id: p.id, campaignId: campaign.id })}
                      className="rounded-md border border-[var(--hob-rule)] px-2.5 py-1 text-[12px] font-semibold text-[var(--hob-ink)] hover:bg-[var(--hob-hover)]"
                    >
                      יצירת לינק
                    </button>
                  )}
                  {p.status === "linked" &&
                    (() => {
                      // The link is born at the top of the page — hand its
                      // URL right here so promoting never feels like a dead click.
                      const pl = allLinks.find((l) => l.id === p.link_id);
                      if (!pl) return null;
                      return (
                        <button
                          type="button"
                          title={pageURL(settings, pl.token)}
                          onClick={() => copyText(pageURL(settings, pl.token), 200000 + p.id)}
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
                      onClick={() => act.mutate({ action: "prospect_status", id: p.id, status: prevP.key })}
                      className="rounded-md border border-[var(--hob-rule)] px-1.5 py-1 text-[12px] text-[var(--hob-faint)] hover:bg-[var(--hob-hover)]"
                    >
                      ↩
                    </button>
                  )}
                  <button
                    type="button"
                    title={next ? `מעבר ל: ${next.label}` : st.label}
                    disabled={!next}
                    onClick={() => next && act.mutate({ action: "prospect_status", id: p.id, status: next.key })}
                    className="rounded-md px-2.5 py-1 text-[12px] font-bold text-white disabled:opacity-70"
                    style={{ backgroundColor: st.bg }}
                  >
                    {st.label}
                  </button>
                  <DeleteButton onConfirm={() => act.mutate({ action: "delete_prospect", id: p.id })} />
                </span>
                {open && <ProspectCard p={p} act={(body) => act.mutate(body)} />}
              </div>
            );
          })}
        </div>
        {prospects.some((p) => p.status === "rejected") && (
          <details className="mt-3">
            <summary className="cursor-pointer text-[12.5px] font-semibold text-[var(--hob-faint)]">
              🗄️ ארכיון ({prospects.filter((p) => p.status === "rejected").length}) — נשמרות כדי שלא ניצור כפילויות
            </summary>
            <div className="mt-2 flex flex-col gap-1">
              {prospects
                .filter((p) => p.status === "rejected")
                .map((p) => (
                  <div
                    key={p.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-[var(--hob-rule)] px-3 py-1.5 opacity-60"
                  >
                    <span className="text-[12.5px] font-semibold text-[var(--hob-ink)]">{p.name}</span>
                    {p.instagram && (
                      <span dir="ltr" className="text-[11.5px] text-[var(--hob-faint)]">
                        @{p.instagram}
                      </span>
                    )}
                    {p.followers > 0 && <span className="text-[11px] text-[var(--hob-faint)]">{fmtFollowers(p.followers)}</span>}
                    <button
                      type="button"
                      onClick={() => act.mutate({ action: "prospect_status", id: p.id, status: "to_contact" })}
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
