// Dependency-free toast, in the spirit of fireConfetti: plain DOM, no React
// state — safe to call from anywhere (mutation callbacks, the router's global
// MutationCache handler). One floating chip at the bottom center; a new call
// replaces the current text and restarts the timer.

let el: HTMLDivElement | null = null;
let hideTimer: ReturnType<typeof setTimeout> | undefined;

export function toast(msg: string, kind: "ok" | "error" = "ok"): void {
  if (typeof document === "undefined") return; // SSR — nothing to show
  if (!el || !document.body.contains(el)) {
    el = document.createElement("div");
    el.setAttribute("dir", "rtl");
    el.style.cssText =
      "position:fixed;bottom:22px;left:50%;transform:translateX(-50%) translateY(8px);" +
      "z-index:120;padding:9px 18px;border-radius:10px;font-size:14px;font-weight:500;" +
      "color:#fff;box-shadow:0 4px 14px rgba(0,0,0,.22);pointer-events:none;" +
      "opacity:0;transition:opacity .18s ease,transform .18s ease;max-width:calc(100vw - 32px)";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  // הצ'יפ הרגיל בהיפוך דיו (כמו הטאב הפעיל); שגיאה תמיד אדומה עם לבן.
  el.style.background = kind === "error" ? "#e2445c" : "var(--hob-ink, #323338)";
  el.style.color = kind === "error" ? "#fff" : "var(--hob-bg, #fff)";
  // Force a style flush so re-showing during the fade restarts the transition.
  void el.offsetHeight;
  el.style.opacity = "1";
  el.style.transform = "translateX(-50%) translateY(0)";
  clearTimeout(hideTimer);
  hideTimer = setTimeout(
    () => {
      if (!el) return;
      el.style.opacity = "0";
      el.style.transform = "translateX(-50%) translateY(8px)";
    },
    kind === "error" ? 4200 : 2200,
  );
}
