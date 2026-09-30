import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import appCss from "../styles.css?url";
// Page metadata (browser <title>/favicon + social og: tags), read at build time.
import appMetaJson from "../app-meta.json";

// Built-in defaults for any field that isn't set in app-meta.json.
const DEFAULT_TITLE = "hob | הלוח";
const DEFAULT_DESCRIPTION = "הלוח של House of Bais";

type AppMeta = {
  og_title?: string | null;
  og_description?: string | null;
  og_image_url?: string | null;
  favicon_url?: string | null;
  og_video_url?: string | null;
};

const appMeta = appMetaJson as AppMeta;

// Build the document head (title / description / og: / twitter: / favicon) from
// app-meta.json, falling back to the defaults above for any unset field.
// og_title/og_description double as the browser <title> and meta description;
// og_image_url (when set) also drives the twitter card + image. Built from
// inline tag literals (conditional spreads for the optional image/favicon) so
// it matches the head() shape TanStack expects.
function toOwnAssetUrl(value: string | null | undefined): string | null {
  return value || null;
}

function buildHead(meta: AppMeta) {
  const title = meta.og_title ?? DEFAULT_TITLE;
  const description = meta.og_description ?? DEFAULT_DESCRIPTION;
  const ogImage = toOwnAssetUrl(meta.og_image_url);
  const favicon = toOwnAssetUrl(meta.favicon_url);
  const ogVideo = toOwnAssetUrl(meta.og_video_url);

  return {
    meta: [
      { charSet: "utf-8" },
      // viewport-fit=cover lets env(safe-area-inset-bottom) lift pinned bars
      // above the iPhone home indicator in the installed (standalone) app.
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { title },
      { name: "description", content: description },
      { property: "og:title", content: title },
      { property: "og:description", content: description },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: ogImage ? "summary_large_image" : "summary" },
      ...(ogImage
        ? [
            { property: "og:image", content: ogImage },
            { name: "twitter:image", content: ogImage },
          ]
        : []),
      ...(ogVideo ? [{ property: "og:video", content: ogVideo }] : []),
      // PWA: installed to the iPhone home screen it opens standalone,
      // full-screen without browser chrome.
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-status-bar-style", content: "default" },
      { name: "apple-mobile-web-app-title", content: "hob" },
      { name: "theme-color", content: "#faf6e9" },
    ],
    links: [
      // Fonts as <link> instead of a CSS @import: the browser starts fetching
      // them with the HTML instead of after the whole stylesheet arrives.
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" as const },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Assistant:wght@400;600;700;800&family=IBM+Plex+Mono:wght@500;600&family=Rubik:wght@400;500;600;700&display=swap",
      },
      { rel: "stylesheet", href: appCss },
      ...(favicon ? [{ rel: "icon", href: favicon }] : []),
      { rel: "manifest", href: "/manifest.webmanifest" },
      { rel: "apple-touch-icon", href: "/assets/apple-touch-icon.png" },
    ],
  };
}

function NotFoundComponent() {
  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <div className="mx-auto max-w-md text-center">
        <div className="text-5xl font-bold text-[var(--hob-ink)]">404</div>
        <p className="mt-2 text-[var(--hob-soft)]">הדף שחיפשתם לא קיים.</p>
        <Link
          to="/"
          className="mt-4 inline-block rounded-lg bg-[var(--hob-accent)] px-4 py-2 font-bold text-[var(--hob-accent-fg)] hover:bg-[var(--hob-accent-hover)]"
        >
          חזרה ללוח
        </Link>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: ErrorComponentProps) {
  console.error(error);
  const router = useRouter();

  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold text-[var(--hob-ink)]">הדף לא נטען</h1>
        <p className="mt-2 text-sm text-[var(--hob-soft)]">
          משהו השתבש אצלנו. אפשר לנסות שוב או לחזור ללוח.
        </p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="rounded-lg bg-[var(--hob-accent)] px-4 py-2 font-bold text-[var(--hob-accent-fg)] hover:bg-[var(--hob-accent-hover)]"
          >
            ניסיון נוסף
          </button>
          <a
            href="/"
            className="rounded-lg border border-[var(--hob-rule-strong)] px-4 py-2 font-medium text-[var(--hob-ink)] hover:bg-[var(--hob-hover)]"
          >
            חזרה ללוח
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  // Read the committed page metadata at build time (no runtime fetch).
  head: () => buildHead(appMeta),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

// Black-screen self-heal: after a deploy, a phone can hold stale HTML whose
// hashed bundles now 404 — no JS runs, only the dark background paints. This
// inline script (runs even when the app bundle never loads) reloads once or
// twice, then gives up with a visible message instead of an empty screen.
// RootComponent sets __HOB_BOOTED and clears the counter on a healthy boot.
const BOOT_WATCHDOG = `
(function () {
  try {
    var KEY = "hob_reboot";
    setTimeout(function () {
      try {
        if (window.__HOB_BOOTED) return;
        var n = +(sessionStorage.getItem(KEY) || 0);
        if (n < 2) {
          sessionStorage.setItem(KEY, String(n + 1));
          location.reload();
        } else {
          document.body.innerHTML =
            '<div style="min-height:100dvh;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;font-family:sans-serif;color:#4f463c">' +
            '<div><div style="font-size:17px;font-weight:700">הלוח לא מצליח להיטען</div>' +
            '<div style="margin-top:8px;font-size:14px;color:#8a8178">בדקו את החיבור לאינטרנט ופתחו שוב</div></div></div>';
          sessionStorage.removeItem(KEY);
        }
      } catch (e) {}
    }, 12000);
  } catch (e) {}
})();
`;

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="he" dir="rtl">
      <head>
        <HeadContent />
        <script dangerouslySetInnerHTML={{ __html: BOOT_WATCHDOG }} />
      </head>
      <body className="bg-[var(--hob-bg)] text-[var(--hob-ink)] antialiased">
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  useEffect(() => {
    // Healthy boot: disarm the black-screen watchdog. A lazy chunk that 404s
    // after a deploy (vite:preloadError) still gets one guarded reload.
    (window as unknown as { __HOB_BOOTED?: boolean }).__HOB_BOOTED = true;
    try {
      sessionStorage.removeItem("hob_reboot");
    } catch {
      // Private-mode storage failures must never break the app.
    }
    const onPreloadError = () => {
      try {
        if (sessionStorage.getItem("hob_chunk_reload")) return;
        sessionStorage.setItem("hob_chunk_reload", "1");
      } catch {
        // Fall through to a single unguarded reload.
      }
      window.location.reload();
    };
    window.addEventListener("vite:preloadError", onPreloadError);
    const disarm = setTimeout(() => {
      try {
        sessionStorage.removeItem("hob_chunk_reload");
      } catch {}
    }, 10_000);
    return () => {
      window.removeEventListener("vite:preloadError", onPreloadError);
      clearTimeout(disarm);
    };
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      {/* Required: nested routes render here. Removing <Outlet /> breaks all child routes. */}
      <Outlet />
    </QueryClientProvider>
  );
}
