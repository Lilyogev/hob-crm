import type {
  CollabCampaign,
  CollabLink,
  CollabProduct,
  CollabSettings,
  MySale,
  StockOffer,
} from "./collab.server";

// Type-only import above: this file must stay free of server bindings so the
// route modules that render it never drag `cloudflare:workers` around.
function saleURL(s: CollabSettings, code: string): string {
  return `${s.base}/s/${code}`;
}

// The public influencer invite page (/c/<token>), her stats page (/my/<token>)
// and the branded dead end. Server-rendered plain HTML on purpose — no
// React/SSR in the path an influencer's in-app browser has to survive.
// Brand name, store URL, instagram handle, WhatsApp number, hero image and
// the percentages all come from `settings` through CollabSettings.

function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const SWATCHES: Record<string, string> = {
  "שחור": "#141414",
  "כחול": "#3a5da8",
  "לבן": "#f5f5f5",
  "אפור": "#9a9a9a",
  "ירוק": "#00854d",
  "אדום": "#c0392b",
  "בז׳": "#d9c7a7",
  "ורוד": "#e8a6b8",
};
function swatch(name: string): string {
  return SWATCHES[name.trim()] ?? "#c4c4c4";
}

function parseList(json: string, fallback: string[]): string[] {
  try {
    const v = JSON.parse(json);
    if (Array.isArray(v) && v.every((x) => typeof x === "string") && v.length) return v;
  } catch {
    // fall through to the fallback list
  }
  return fallback;
}

const WA_ICON =
  '<svg class="wa" viewBox="0 0 24 24" aria-hidden="true"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22h.01c5.46 0 9.9-4.45 9.9-9.91A9.87 9.87 0 0 0 12.04 2zm0 18.03h-.01a8.2 8.2 0 0 1-4.18-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.2 8.2 0 0 1-1.26-4.38c0-4.54 3.7-8.24 8.25-8.24a8.2 8.2 0 0 1 8.23 8.25c0 4.54-3.7 8.23-8.24 8.23zm4.52-6.16c-.25-.13-1.47-.72-1.69-.81-.23-.08-.39-.12-.56.13-.16.24-.64.8-.78.97-.14.16-.29.18-.54.06-.25-.13-1.05-.39-2-1.23-.74-.66-1.23-1.47-1.38-1.72-.14-.25-.02-.38.11-.51.11-.11.25-.29.37-.43.12-.14.16-.25.25-.41.08-.17.04-.31-.02-.43-.06-.13-.56-1.34-.76-1.84-.2-.48-.41-.42-.56-.43h-.48c-.17 0-.43.06-.66.31-.22.25-.86.85-.86 2.07 0 1.22.89 2.4 1.01 2.56.12.17 1.75 2.67 4.23 3.74.59.26 1.05.41 1.41.52.59.19 1.13.16 1.56.1.48-.07 1.47-.6 1.67-1.18.21-.58.21-1.07.15-1.18-.06-.11-.22-.17-.47-.3z"/></svg>';

function waLink(s: CollabSettings, text: string): string {
  return s.whatsapp
    ? `https://wa.me/${s.whatsapp}?text=${encodeURIComponent(text)}`
    : "";
}

function igLink(s: CollabSettings): string {
  return s.instagram ? `https://instagram.com/${s.instagram}` : "";
}

// Text logo: the brand name in caps, letter-spaced. No image asset to host.
function wordmark(s: CollabSettings, cls = "brand"): string {
  return `<span class="${cls}" dir="ltr">${esc(s.brandName.toUpperCase())}</span>`;
}

const BASE_CSS = `
  :root{--paper:#FFFFFF;--ink:#111111;--text:#585757;--line:#E8E8E8;--soft:#F7F7F7;--green:#00a359}
  *{box-sizing:border-box;margin:0;padding:0}
  html{-webkit-text-size-adjust:100%;scroll-behavior:smooth}
  body{background:var(--soft);color:var(--text);font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.7}
  .brand{font-weight:700;letter-spacing:.32em;color:var(--ink);font-size:14px}
  .btn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;padding:16px;border-radius:0;font:inherit;font-weight:700;font-size:14px;letter-spacing:.2em;cursor:pointer;border:1px solid var(--ink);text-decoration:none;color:var(--ink);background:var(--paper);transition:transform .1s ease}
  .btn:active{transform:scale(.99)}
  .btn.primary{background:var(--ink);color:#fff}
  .btn.primary[disabled]{opacity:.6;cursor:wait}
  .btn.ghost{margin-top:10px;letter-spacing:.03em;font-size:14px}
  .btn .wa{width:18px;height:18px;fill:#25D366;flex:none}
  @media (prefers-reduced-motion: reduce){*{transition:none !important}html{scroll-behavior:auto}}
`;

// A dead personal link (deleted or mistyped) answers with a branded dead end
// that still routes her somewhere useful.
export function renderCollabNotFound(s: CollabSettings): string {
  const wa = waLink(s, `היי, קיבלתי לינק לשיתוף פעולה עם ${s.brandName} והוא לא נפתח`);
  const ig = igLink(s);
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(s.brandName)}</title>
<style>
${BASE_CSS}
  body{background:var(--paper);color:var(--ink);min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center}
  .brand{display:block;margin-bottom:26px;font-size:18px}
  h1{font-size:20px;font-weight:700;letter-spacing:.02em}
  p{margin-top:10px;font-size:14px;color:#585757;line-height:1.6}
  .btns{margin-top:26px;max-width:280px;margin-inline:auto}
  .btn+.btn{margin-top:10px;letter-spacing:.03em}
</style>
</head>
<body>
<div>
  ${wordmark(s)}
  <h1>הלינק הזה כבר לא פעיל</h1>
  <p>אולי הוא הוחלף בלינק חדש. דברו איתנו ונסדר את זה.</p>
  <div class="btns">
    ${s.storeUrl ? `<a class="btn primary" href="${esc(s.storeUrl)}">לחנות</a>` : ""}
    ${ig ? `<a class="btn" href="${esc(ig)}"><span dir="ltr">@${esc(s.instagram)}</span>&nbsp;באינסטגרם</a>` : ""}
    ${wa ? `<a class="btn" href="${esc(wa)}">${WA_ICON}דברו איתנו בווצאפ</a>` : ""}
  </div>
</div>
</body>
</html>`;
}

export function renderCollabPage(
  s: CollabSettings,
  link: CollabLink,
  campaign: CollabCampaign,
  product: CollabProduct,
  products: CollabProduct[],
  offers: StockOffer[],
): string {
  void products;
  const brand = esc(s.brandName);
  const chooseMode = link.product_id == null && offers.length > 0;
  const picks = Math.min(3, Math.max(1, link.picks || 1));
  const firstName = esc(link.name.trim().split(/\s+/)[0] || link.name);
  const ig = esc(link.instagram.replace(/^@/, ""));
  const asks = parseList(campaign.asks, ["רילס אחד", "סטורי עם תיוג"]);
  const sizes = chooseMode ? [] : parseList(product.sizes, []);
  const colors = chooseMode ? [] : parseList(product.colors, []);
  const offersJson = JSON.stringify(offers.map((o) => ({ id: o.id, name: o.name, sizes: o.sizes })));
  const generic = !!link.is_generic;
  // Gendered copy for a personal link; neutral for generic links and unknowns.
  const g = link.gender === "m" ? "m" : link.gender === "f" ? "f" : "";
  const invited = g === "m" ? "הוזמנת" : g === "f" ? "הוזמנת" : "הוזמנתם";
  const you = g === "m" ? "אתה" : g === "f" ? "את" : "אתם";
  const title = generic
    ? `רוצים לשתף פעולה עם ${brand}?`
    : `${firstName}, ${invited} לשתף פעולה עם ${brand}`;
  const heroTitle = generic
    ? `רוצים לשתף פעולה<br>עם ${wordmark(s, "brand-inline")}?`
    : `${firstName},<br>${invited} לשתף פעולה עם ${wordmark(s, "brand-inline")}`;
  const ctaText = g === "m" ? "אני בפנים" : g === "f" ? "אני בפנים" : "אנחנו בפנים";
  const successBig =
    g === "m"
      ? "ברוך הבא, הבקשה התקבלה 🖤"
      : g === "f"
        ? "ברוכה הבאה, הבקשה התקבלה 🖤"
        : "הבקשה התקבלה 🖤";
  const wa = waLink(s, `היי, קיבלתי את ההזמנה לשיתוף פעולה עם ${s.brandName} ואשמח לדבר`);
  const hero = s.heroUrl
    ? `<div class="hero photo">
    <img class="photo" src="${esc(s.heroUrl)}" alt="${brand}">
    <div class="veil"></div>
    <div class="logo">${wordmark(s, "brand light")}</div>
    <div class="txt">
      <p class="small">הזמנה אישית${ig ? ` · <span dir="ltr">@${ig}</span>` : ""}</p>
      <h1>${heroTitle}</h1>
      ${link.personal_note ? `<p class="plead">${esc(link.personal_note)}</p>` : ""}
    </div>
  </div>`
    : `<div class="hero plain">
    <div class="logo">${wordmark(s, "brand light")}</div>
    <div class="txt">
      <p class="small">הזמנה אישית${ig ? ` · <span dir="ltr">@${ig}</span>` : ""}</p>
      <h1>${heroTitle}</h1>
      ${link.personal_note ? `<p class="plead">${esc(link.personal_note)}</p>` : ""}
    </div>
  </div>`;

  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${brand} · שיתוף פעולה</title>
<meta property="og:type" content="website">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${esc(product.name || "פריט מהקולקציה")} במתנה + קוד אישי ועמלה על כל מכירה. מתחילים בקטן ואם החיבור עובד ממשיכים.">
${s.heroUrl ? `<meta property="og:image" content="${esc(s.heroUrl)}">` : ""}
<style>
${BASE_CSS}
  .page{max-width:560px;margin:0 auto;background:var(--paper);min-height:100vh;position:relative}
  .topbar{background:#8e8e8e;color:#fff;text-align:center;font-size:11px;letter-spacing:.1em;padding:8px 12px}
  .hero{position:relative;color:#fff}
  .hero.plain{background:var(--ink);padding:88px 26px 40px}
  .hero.photo img.photo{width:100%;display:block;object-fit:cover;aspect-ratio:3/4;min-height:540px;max-height:78vh}
  .hero .veil{position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.42) 0%,rgba(0,0,0,0) 22%),linear-gradient(180deg,rgba(0,0,0,0) 42%,rgba(0,0,0,.62) 100%)}
  .hero .logo{position:absolute;top:22px;inset-inline:0;text-align:center}
  .brand.light{color:#fff}
  .brand-inline{font-weight:700;letter-spacing:.12em;white-space:nowrap}
  .hero.photo .txt{position:absolute;bottom:0;inset-inline:0;padding:30px 26px 34px}
  .hero .small{font-size:11px;letter-spacing:.24em;opacity:.9}
  .hero h1{font-size:30px;font-weight:700;line-height:1.25;margin-top:8px;letter-spacing:.01em;text-wrap:balance;text-shadow:0 1px 14px rgba(0,0,0,.35)}
  .hero .plead{margin-top:10px;font-size:14.5px;line-height:1.55;color:rgba(255,255,255,.92);max-width:44ch}
  .proof{display:grid;grid-template-columns:1fr 1fr;border-bottom:1px solid var(--line)}
  .proof div{padding:16px 6px;text-align:center}
  .proof div:nth-child(even){border-inline-start:1px solid var(--line)}
  .proof b{display:block;color:var(--ink);font-size:16px;letter-spacing:.02em;font-variant-numeric:tabular-nums}
  .proof span{font-size:11px;color:#9a9a9a;letter-spacing:.04em}
  section{padding:44px 26px;border-bottom:1px solid var(--line)}
  .label{text-align:center;font-size:11px;font-weight:700;letter-spacing:.3em;color:var(--ink);margin-bottom:20px;text-transform:uppercase}
  p{max-width:60ch}
  .center p{margin-inline:auto;text-align:center}
  .center p.lead{font-size:16px;color:#3d3d3b}
  .rv{opacity:0;transform:translateY(14px);transition:opacity .6s ease,transform .6s ease}
  .rv.on{opacity:1;transform:none}
  .pgrid{display:flex;gap:8px;overflow-x:auto;scroll-snap-type:x mandatory;padding:2px 2px 8px;-webkit-overflow-scrolling:touch;scrollbar-width:none}
  .pgrid::-webkit-scrollbar{display:none}
  .pgrid .pcard{flex:0 0 44%;scroll-snap-align:start}
  .pcard{border:1px solid #cfcfcf;border-radius:0;padding:0 0 10px;background:var(--paper);cursor:pointer;font-family:inherit;text-align:center;transition:all .12s ease}
  .pcard img,.pcard .noimg{width:100%;aspect-ratio:4/5;object-fit:cover;display:block;margin-bottom:8px;background:var(--soft)}
  .pcard .noimg{display:grid;place-content:center;color:#bdbdbd;font-size:11px;letter-spacing:.2em}
  .pcard:hover{border-color:var(--ink)}
  .pcard[aria-pressed="true"]{border-color:var(--ink);box-shadow:0 0 0 1.5px var(--ink)}
  .pcname{display:block;font-weight:700;font-size:12px;color:var(--ink);padding:0 4px;line-height:1.4}
  .pcval{display:block;font-size:11.5px;color:var(--text);margin-top:2px}
  .product img.main{width:100%;display:block;aspect-ratio:4/5;object-fit:cover;background:var(--soft)}
  .prow{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-top:16px;flex-wrap:wrap}
  .pname{color:var(--ink);font-weight:700;font-size:17px;letter-spacing:.03em}
  .pval{font-size:13px}
  .asks{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
  .ask{border:1px solid var(--ink);color:var(--ink);padding:6px 14px;font-size:12px;font-weight:700;letter-spacing:.06em}
  .brieftxt{margin-top:16px;font-size:14.5px;white-space:pre-line}
  .partner{margin-top:20px;border:1px solid var(--ink);padding:4px 18px 6px}
  .ptitle{font-weight:700;font-size:14px;color:var(--ink);letter-spacing:.04em;padding:12px 0 8px}
  .pline{font-size:14px;line-height:1.6;padding:9px 0;border-top:1px solid var(--line)}
  .pline b{color:var(--ink)}
  .checks{border-top:1px solid var(--line)}
  .privcheck{border-bottom:none;margin-top:14px;padding:0 2px 0}
  #floorApt{margin-top:0}
  #floorApt.off{display:none}
  .check{display:flex;gap:14px;align-items:flex-start;padding:16px 2px;border-bottom:1px solid var(--line);cursor:pointer;font-size:14px;line-height:1.55;color:var(--text)}
  .check input{appearance:none;-webkit-appearance:none;flex:none;width:19px;height:19px;margin-top:2px;border:1.5px solid #c4c4c4;display:grid;place-content:center;cursor:pointer;background:var(--paper);transition:background .15s ease}
  .check input:checked{background:var(--ink);border-color:var(--ink)}
  .check input:checked::before{content:"";width:9px;height:9px;clip-path:polygon(14% 44%,0 65%,50% 100%,100% 16%,80% 0,43% 62%);background:#fff}
  .check input:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
  .field{margin-top:18px}
  .field label{display:block;font-size:11.5px;font-weight:700;letter-spacing:.14em;color:var(--ink);margin-bottom:7px}
  .field input{width:100%;border:1px solid #cfcfcf;border-radius:0;padding:13px 14px;font:inherit;font-size:15px;background:var(--paper);color:var(--ink);transition:border-color .15s ease}
  .field input:focus{outline:none;border-color:var(--ink)}
  .row2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .sizes{display:flex;gap:8px;flex-wrap:wrap}
  .colorbtn{display:flex;align-items:center;gap:8px;padding:11px 16px;border:1px solid #cfcfcf;border-radius:0;font-weight:700;font-size:14px;cursor:pointer;background:var(--paper);color:var(--ink);font-family:inherit;transition:all .12s ease}
  .colorbtn:hover{border-color:var(--ink)}
  .colorbtn .dot{width:14px;height:14px;border-radius:50%;border:1px solid rgba(0,0,0,.2);flex:none}
  .colorbtn[aria-pressed="true"]{background:var(--ink);color:#fff;border-color:var(--ink)}
  .size{min-width:54px;padding:11px 0;text-align:center;border:1px solid #cfcfcf;border-radius:0;font-weight:700;font-size:14px;cursor:pointer;background:var(--paper);color:var(--ink);font-family:inherit;transition:all .12s ease}
  .size:hover{border-color:var(--ink)}
  .size[aria-pressed="true"]{background:var(--ink);color:#fff;border-color:var(--ink)}
  .size:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
  .cta{border-bottom:none;padding-bottom:50px}
  .fine{text-align:center;font-size:12px;color:#9a9a9a;margin-top:16px}
  .err{display:none;text-align:center;font-size:13px;color:#e2445c;margin-top:12px}
  .success{display:none;text-align:center;padding:10px 0 4px}
  .success .big{font-size:24px;font-weight:700;color:var(--ink);letter-spacing:.02em}
  .success p{margin:10px auto 0}
  .sticky{position:fixed;bottom:0;inset-inline:0;z-index:40;max-width:560px;margin:0 auto;background:rgba(255,255,255,.96);backdrop-filter:blur(6px);border-top:1px solid var(--line);padding:10px 16px calc(10px + env(safe-area-inset-bottom));transform:translateY(110%);transition:transform .3s ease}
  .sticky.on{transform:none}
  .sticky a{display:block;background:var(--ink);color:#fff;text-align:center;padding:13px;font-weight:700;font-size:13px;letter-spacing:.2em;text-decoration:none}
  footer{background:#8e8e8e;color:#fff;text-align:center;padding:36px 26px 44px}
  footer .brand{color:#fff}
  footer .ig{font-size:12px;color:rgba(255,255,255,.7);margin-top:8px}
  @media (prefers-reduced-motion: reduce){.rv{opacity:1;transform:none}}
</style>
</head>
<body>
<div class="page">

  <div class="topbar">ההצטרפות בחינם · המשלוח עלינו</div>

  ${hero}

  <div class="proof">
    <div><b>פריט במתנה</b><span>בלי התחייבות</span></div>
    <div><b>${s.commissionPct}% עמלה</b><span>על כל מכירה עם הקוד</span></div>
  </div>

  <section class="center rv">
    <p class="label">מי אנחנו</p>
    <p class="lead">${brand} הוא מותג אופנה של שתי שותפות. אנחנו מחפשות יוצרות ויוצרים שהחיבור איתם טבעי.</p>
    <p style="margin-top:12px">המודל שלנו פשוט: מתחילים בקטן, מודדים ביחד, ואם החיבור עובד ממשיכים לשותפות ארוכת טווח.</p>
  </section>

  <section class="rv">
    <p class="label">מה ${you === "אתם" ? "תקבלו" : g === "m" ? "תקבל" : "תקבלי"}</p>
    <div class="product">
      ${
        chooseMode
          ? `<p style="margin-bottom:14px;font-size:14.5px">${
              picks > 1
                ? `בחרו עד ${picks} פריטים מהמלאי, במתנה:`
                : "בחרו מה מתאים לכם מהמלאי, פריט אחד במתנה:"
            }</p>
      <div class="pgrid" id="pgrid">
        ${offers
          .map(
            (o, i) =>
              `<button type="button" class="pcard" data-id="${o.id}" aria-pressed="${i === 0 ? "true" : "false"}">
                ${o.image ? `<img src="${esc(o.image)}" alt="${esc(o.name)}">` : `<span class="noimg">${brand}</span>`}
                <span class="pcname">${esc(o.name)}</span>
                <span class="pcval">${o.price > 0 ? `שווי ₪${o.price} · ` : ""}מתנה</span>
              </button>`,
          )
          .join("")}
      </div>`
          : `${product.image ? `<img class="main" src="${esc(product.image)}" alt="${esc(product.name)}">` : ""}
      <div class="prow">
        <span class="pname">${esc(product.name || "פריט מהקולקציה")}</span>
        <span class="pval">${product.value > 0 ? `שווי ₪${product.value} · ` : ""}מתנה</span>
      </div>`
      }
      <div class="asks">${asks.map((a) => `<span class="ask">${esc(a)}</span>`).join("")}</div>
      ${campaign.brief ? `<p class="brieftxt">${esc(campaign.brief)}</p>` : ""}
      <div class="partner">
        <p class="ptitle">מעבר למתנה, זו שותפות:</p>
        <div class="pline"><b>קוד אישי על השם שלכם:</b> לעוקבים שלכם ${s.discountPct}% הנחה על כל החנות</div>
        <div class="pline"><b>${s.commissionPct}% עמלה לכם</b> מכל הזמנה שנכנסת עם הקוד</div>
        <div class="pline"><b>אנחנו עוקבות אחרי המכירות</b> ומעדכנות אתכם. הקוד מחכה לכם אחרי האישור</div>
      </div>
    </div>
  </section>

  <section class="rv">
    <p class="label">ההסכמות בינינו</p>
    <div class="checks">
      <label class="check"><input type="checkbox">אעלה את הרילס תוך 10 ימים מקבלת המוצר</label>
      <label class="check"><input type="checkbox">אתייג את ${s.instagram ? `<span dir="ltr">@${esc(s.instagram)}</span>` : brand} ברילס ובסטורי</label>
      <label class="check"><input type="checkbox">אסמן את התוכן כשיתוף פעולה לפי כללי הפלטפורמה</label>
      <label class="check"><input type="checkbox">אשלח לכן את קובץ הסרטון המקורי, ואפשר ל${brand} להשתמש בו בעמוד ובפרסום</label>
    </div>
  </section>

  <section class="rv" id="join">
    <p class="label">הפרטים שלך</p>
    <form id="signup">
      <div class="field" style="margin-top:0">
        <label>שם מלא</label>
        <input name="full_name" type="text" required value="${generic ? "" : esc(link.name)}">
      </div>
      <div class="field">
        <label>אינסטגרם (בלי @)</label>
        <input name="instagram" type="text" inputmode="latin" dir="ltr" value="${ig}">
      </div>
      <div class="row2">
        <div class="field">
          <label>ווצאפ</label>
          <input name="phone" type="tel" dir="ltr" required placeholder="050-0000000">
        </div>
        <div class="field">
          <label>אימייל</label>
          <input name="email" type="email" dir="ltr" placeholder="you@gmail.com">
        </div>
      </div>
      ${
        chooseMode
          ? `<div id="sizeBlocks"></div>`
          : `<div class="field" id="colorField" style="display:${colors.length ? "block" : "none"}">
        <label>צבע</label>
        <div class="sizes" role="group" aria-label="צבע" id="colorWrap">
          ${colors
            .map(
              (c, i) =>
                `<button type="button" class="colorbtn" data-color="${esc(c)}" aria-pressed="${i === 0 ? "true" : "false"}"><span class="dot" style="background:${swatch(c)}"></span>${esc(c)}</button>`,
            )
            .join("")}
        </div>
      </div>
      <div class="field" id="sizeField" style="display:${sizes.length ? "block" : "none"}">
        <label>מידה</label>
        <div class="sizes" role="group" aria-label="מידה" id="sizeWrap">
          ${sizes.map((sz) => `<button type="button" class="size" aria-pressed="false">${esc(sz)}</button>`).join("")}
        </div>
      </div>`
      }
      <div class="row2">
        <div class="field" style="flex:2">
          <label>רחוב</label>
          <input name="street" type="text" required placeholder="שם הרחוב">
        </div>
        <div class="field">
          <label>מספר בית</label>
          <input name="house" type="text" required placeholder="12">
        </div>
      </div>
      <div class="field">
        <label>עיר</label>
        <input name="city" type="text" required placeholder="תל אביב">
      </div>
      <div class="row2" id="floorApt">
        <div class="field">
          <label>קומה</label>
          <input name="floor" type="text" placeholder="3">
        </div>
        <div class="field">
          <label>דירה</label>
          <input name="apt" type="text" placeholder="4">
        </div>
      </div>
      <label class="check privcheck"><input type="checkbox" id="privateHouse">אני גר/ה בבית פרטי (בלי קומה ודירה)</label>
    </form>
  </section>

  <section class="cta rv">
    <div class="success" id="success">
      <p class="big">${successBig}</p>
      <p>קיבלנו את הפרטים. נעבור עליהם ונחזור אליכם בווצאפ עם אישור, הקוד האישי שלכם ולינק לשיתוף.</p>
    </div>
    <button class="btn primary" id="joinBtn" type="button">${ctaText}</button>
    <p class="err" id="err">משהו לא עבד. בדקו שכל שדות החובה מלאים ונסו שוב</p>
    ${wa ? `<a class="btn ghost" href="${esc(wa)}" target="_blank" rel="noopener">${WA_ICON}יש לכם תנאים אחרים? דברו איתנו בווצאפ</a>` : ""}
    <p class="fine">הפרטים משמשים רק למשלוח וליצירת קשר</p>
  </section>

  <footer>
    ${wordmark(s)}
    ${s.instagram ? `<p class="ig" dir="ltr">@${esc(s.instagram)}</p>` : ""}
  </footer>

  <div class="sticky" id="sticky"><a href="#join">${ctaText}</a></div>

</div>
<script>
  var PICKS=${picks};
  var CTA_HTML=${JSON.stringify(ctaText)};
  var CHOOSE=${chooseMode ? "true" : "false"};
  var PRODUCTS=${offersJson};
  var selected=[];
  function pressGroup(sel,el,scope){
    (scope||document).querySelectorAll(sel).forEach(function(x){x.setAttribute("aria-pressed","false")});
    el.setAttribute("aria-pressed","true");
  }
  document.addEventListener("click",function(e){
    var t=e.target.closest(".size");
    if(t){pressGroup(".size",t,t.closest(".sizes"));return;}
    var c=e.target.closest(".colorbtn");
    if(c){pressGroup(".colorbtn",c,c.closest(".sizes"));return;}
    var pc=e.target.closest(".pcard");
    if(pc){toggleCard(Number(pc.getAttribute("data-id")));}
  });
  function toggleCard(id){
    var i=selected.indexOf(id);
    if(i>=0){
      if(selected.length>1)selected.splice(i,1);
    }else{
      selected.push(id);
      while(selected.length>PICKS)selected.shift();
    }
    document.querySelectorAll(".pcard").forEach(function(el){
      el.setAttribute("aria-pressed",selected.indexOf(Number(el.getAttribute("data-id")))>=0?"true":"false");
    });
    renderBlocks();
  }
  function offerOf(id){
    for(var i=0;i<PRODUCTS.length;i++){if(PRODUCTS[i].id===id)return PRODUCTS[i];}
    return null;
  }
  function renderBlocks(){
    var host=document.getElementById("sizeBlocks");
    if(!host)return;
    // Re-rendering must not erase a size the visitor already tapped.
    var keep={};
    host.querySelectorAll(".sizes[data-item]").forEach(function(g){
      var b=g.querySelector('.size[aria-pressed="true"]');
      if(b)keep[g.getAttribute("data-item")]=b.textContent.trim();
    });
    var html="";
    selected.forEach(function(id){
      var pr=offerOf(id);
      if(!pr||!pr.sizes.length)return;
      html+='<div class="field"><label>'+(PICKS>1?"מידה ל"+pr.name:"מידה")+'</label>'+
        '<div class="sizes" role="group" data-item="'+id+'">'+
        pr.sizes.map(function(x){
          return '<button type="button" class="size" aria-pressed="'+(keep[String(id)]===x?"true":"false")+'">'+x+'</button>';
        }).join("")+'</div></div>';
    });
    host.innerHTML=html;
  }
  if(CHOOSE&&PRODUCTS.length){selected=[PRODUCTS[0].id];toggleCard(PRODUCTS[0].id);toggleCard(PRODUCTS[0].id);}
  document.getElementById("privateHouse").addEventListener("change",function(){
    document.getElementById("floorApt").classList.toggle("off",this.checked);
  });
  var io=new IntersectionObserver(function(es){es.forEach(function(e){
    if(e.isIntersecting){e.target.classList.add("on");io.unobserve(e.target);}
  })},{threshold:.12});
  document.querySelectorAll(".rv").forEach(function(el){io.observe(el)});
  var sticky=document.getElementById("sticky");
  var join=document.getElementById("join");
  addEventListener("scroll",function(){
    var past=scrollY>500;
    var j=join.getBoundingClientRect();
    var formVisible=j.top<innerHeight&&j.bottom>0;
    sticky.classList.toggle("on",past&&!formVisible&&!window.__joined);
  },{passive:true});

  var btn=document.getElementById("joinBtn");
  btn.addEventListener("click",function(){
    var f=document.getElementById("signup");
    var err=document.getElementById("err");
    err.style.display="none";
    if(!f.reportValidity())return;
    // No default size is pre-picked — a sized item without a tapped size
    // blocks the send, otherwise wrong-size shipments are on us.
    var missingSizes=[].slice.call(document.querySelectorAll(".sizes")).filter(function(g){
      return g.querySelector(".size")&&!g.querySelector('.size[aria-pressed="true"]');
    });
    if(missingSizes.length){
      err.textContent="רגע, חסרה מידה. בחרו מידה ונסו שוב";
      err.style.display="block";
      missingSizes[0].scrollIntoView({block:"center",behavior:"smooth"});
      return;
    }
    var sizeBtn=document.querySelector('.size[aria-pressed="true"]');
    var data={action:"signup",token:${JSON.stringify(link.token)}};
    ["full_name","instagram","phone","email","street","house","city","apt","floor"].forEach(function(k){
      data[k]=f.elements[k].value;
    });
    var priv=document.getElementById("privateHouse").checked;
    data.is_private=priv;
    if(priv){data.apt="";data.floor="";}
    data.size=sizeBtn?sizeBtn.textContent.trim():"";
    var colorBtn=document.querySelector('.colorbtn[aria-pressed="true"]');
    data.color=colorBtn?colorBtn.getAttribute("data-color"):"";
    if(CHOOSE){
      data.items=selected.map(function(id){
        var wrap=document.querySelector('.sizes[data-item="'+id+'"]');
        var sb=wrap?wrap.querySelector('.size[aria-pressed="true"]'):null;
        return {id:id,size:sb?sb.textContent.trim():""};
      });
      if(data.items.length){data.item_id=data.items[0].id;data.size=data.items[0].size;}
    }
    btn.disabled=true;btn.textContent="שולח…";
    fetch("/api/collab",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(data)})
      .then(function(r){return r.json()})
      .then(function(res){
        if(!res.ok)throw new Error("bad");
        window.__joined=true;
        btn.style.display="none";
        document.getElementById("success").style.display="block";
        sticky.classList.remove("on");
      })
      .catch(function(){
        btn.disabled=false;btn.innerHTML=CTA_HTML;
        err.textContent="משהו לא עבד. בדקו שכל שדות החובה מלאים ונסו שוב";
        err.style.display="block";
      });
  });
</script>
</body>
</html>`;
}

// The influencer's private stats page (/my/<token>): her code, share link,
// clicks, orders and commission. Plain HTML for the same reason as /c/.
export function renderMyStatsPage(s: CollabSettings, link: CollabLink, sales: MySale[]): string {
  const brand = esc(s.brandName);
  const firstName = esc(link.name.trim().split(/\s+/)[0] || link.name);
  const code = esc(link.discount_code);
  // A closed collaboration: she still sees the orders and the commission she
  // earned, but the page stops pushing a code that no longer works.
  const ended = !!link.code_ended_at;
  const shareURL = saleURL(s, link.discount_code);
  const rate = s.commissionPct / 100;
  const salesTotal = sales.reduce((sum, x) => sum + (x.total || 0), 0);
  const accrued = Math.round(salesTotal * rate);
  const paid = Math.round(link.commission_paid || 0);
  const due = Math.max(0, accrued - paid);
  const money = (n: number) => `₪${Math.round(n).toLocaleString("en-US")}`;
  const dateHe = (iso: string) => {
    const d = new Date(iso.replace(" ", "T") + "Z");
    return Number.isNaN(d.getTime())
      ? ""
      : d.toLocaleDateString("he-IL", { day: "numeric", month: "numeric", timeZone: "Asia/Jerusalem" });
  };
  const rows = sales
    .map(
      (x) => `<div class="sale"><span class="d">${esc(dateHe(x.created_at))}</span><span>הזמנה בחנות</span><span class="t">${money(x.total)}</span><b class="c">+${money(x.total * rate)}</b></div>`,
    )
    .join("");
  const wa = waLink(s, `היי, זו ${link.name.trim()}, משתפת פעולה עם ${s.brandName}, יש לי שאלה`);
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${brand} · הדף שלי</title>
<style>
${BASE_CSS}
  .page{max-width:560px;margin:0 auto;background:var(--paper);min-height:100dvh;display:flex;flex-direction:column}
  .topbar{background:#8e8e8e;color:#fff;text-align:center;font-size:11px;letter-spacing:.1em;padding:8px 12px}
  header{padding:34px 26px 6px;text-align:center}
  main{padding:10px 26px 34px;flex:1}
  h1{color:var(--ink);font-size:24px;font-weight:700;line-height:1.3;margin-top:18px;text-align:center}
  .sub{text-align:center;font-size:13.5px;margin-top:4px}
  .card{border:1px solid var(--line);margin-top:22px;padding:20px 18px;text-align:center}
  .lbl{font-size:11px;letter-spacing:.22em;color:#8e8e8e}
  .code{font-size:30px;font-weight:700;letter-spacing:.12em;color:var(--ink);margin-top:6px;direction:ltr}
  .codesub{font-size:12.5px;margin-top:6px}
  .card .btn{margin-top:12px;padding:15px;font-size:13.5px;letter-spacing:.06em}
  .card .btn.primary{background:var(--ink);color:#fff}
  .tiles{display:grid;grid-template-columns:1fr 1fr 1fr;border:1px solid var(--line);border-top:none}
  .tiles div{padding:16px 6px;text-align:center;border-inline-start:1px solid var(--line)}
  .tiles div:first-child{border-inline-start:none}
  .tiles b{display:block;font-size:22px;color:var(--ink);font-variant-numeric:tabular-nums}
  .tiles span{font-size:11.5px}
  .pay{display:flex;justify-content:space-between;align-items:center;border:1px solid var(--line);border-top:none;padding:14px 18px;font-size:13.5px}
  .pay b{color:var(--green);font-size:17px;font-variant-numeric:tabular-nums}
  .pay .done{color:#8e8e8e;font-size:12px}
  h2{color:var(--ink);font-size:13px;letter-spacing:.18em;font-weight:700;margin:34px 0 10px;text-align:center}
  .sale{display:flex;align-items:center;gap:12px;border-bottom:1px solid var(--line);padding:11px 2px;font-size:13.5px}
  .sale .d{color:#8e8e8e;font-variant-numeric:tabular-nums;min-width:34px}
  .sale .t{margin-inline-start:auto;font-variant-numeric:tabular-nums}
  .sale .c{color:var(--green);font-variant-numeric:tabular-nums}
  .empty{border:1px dashed var(--line);padding:26px 18px;text-align:center;font-size:13.5px;line-height:1.8}
  .walink{display:block;text-align:center;margin-top:26px;font-size:13px;color:var(--text);text-decoration:underline}
  footer{padding:26px;text-align:center;border-top:1px solid var(--line)}
  footer .ig{font-size:12px;margin-top:4px;color:#8e8e8e}
</style>
</head>
<body>
<div class="page">
  <div class="topbar">${brand} · שיתוף פעולה</div>
  <header>${wordmark(s)}</header>
  <main>
    <h1>היי ${firstName} 🖤</h1>
    <p class="sub">הדף האישי שלך אצל ${brand}. הכל מתעדכן לבד</p>

    <div class="card">
      <p class="lbl">הקוד שלך</p>
      <p class="code">${code}</p>
      <p class="codesub">${
        ended
          ? "שיתוף הפעולה הסתיים והקוד כבר לא פעיל בחנות. מה שצברת נשאר שלך 🖤"
          : `${s.discountPct}% הנחה לעוקבים שלך, ${s.commissionPct}% עמלה לך על כל הזמנה`
      }</p>
      ${
        ended
          ? ""
          : `<button class="btn primary" id="copyBtn" type="button" data-url="${esc(shareURL)}">העתקת הלינק לשיתוף</button>
      <a class="btn" href="${esc(shareURL)}">פתיחת הלינק בחנות</a>`
      }
    </div>

    <div class="tiles">
      <div><b>${link.sale_clicks}</b><span>כניסות מהלינק</span></div>
      <div><b>${sales.length}</b><span>הזמנות</span></div>
      <div><b>${money(accrued)}</b><span>עמלה שנצברה</span></div>
    </div>
    ${
      // Before the first order there is nothing to report; the payout line
      // opens with the first sale.
      accrued <= 0 && paid <= 0
        ? ""
        : `<div class="pay">
      <span>${paid > 0 ? `שולם עד היום ${money(paid)}` : "עוד לא שולמו עמלות"}</span>
      ${due > 0 ? `<b>ממתין לך ${money(due)}</b>` : `<span class="done">✓ הכל משולם</span>`}
    </div>`
    }

    <h2>ההזמנות שהגיעו דרכך</h2>
    ${
      rows ||
      (ended
        ? `<div class="empty">לא נכנסו הזמנות עם הקוד שלך.</div>`
        : `<div class="empty">עוד אין הזמנות עם הקוד שלך.<br>שיתוף אחד בסטורי עם הלינק למעלה וזה בדרך כלל מתחיל לזוז 🖤</div>`)
    }

    ${wa ? `<a class="walink" href="${esc(wa)}">שאלות על העמלה או המשלוח? דברו איתנו בווצאפ</a>` : ""}
  </main>
  <footer>
    ${wordmark(s)}
    ${s.instagram ? `<p class="ig" dir="ltr">@${esc(s.instagram)}</p>` : ""}
  </footer>
</div>
<script>
  // A closed collaboration is served without the copy button, so the script
  // does not assume it exists.
  var copyBtn=document.getElementById("copyBtn");
  if(copyBtn)copyBtn.addEventListener("click",function(){
    var btn=this;
    var done=function(){btn.textContent="הועתק ✓";setTimeout(function(){btn.textContent="העתקת הלינק לשיתוף"},1600)};
    if(navigator.clipboard&&navigator.clipboard.writeText){
      navigator.clipboard.writeText(btn.dataset.url).then(done).catch(function(){window.prompt("העתיקו את הלינק:",btn.dataset.url)});
    }else{window.prompt("העתיקו את הלינק:",btn.dataset.url)}
  });
</script>
</body>
</html>`;
}
