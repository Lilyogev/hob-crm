// בהיר (שנהב, ברירת המחדל של hob) / כהה — 🌓 בסרגל העליון. הטוקנים יושבים על
// :root (כהה) עם דריסה ב-html.ivory (styles.css); כאן רק המתג וההתמדה פר-מכשיר.
import { useSyncExternalStore } from "react";

const KEY = "hob_theme";

function read(): boolean {
  try {
    return localStorage.getItem(KEY) !== "dark";
  } catch {
    return true;
  }
}

const subscribers = new Set<() => void>();
let ivory = true;

export function initTheme(): void {
  if (typeof document === "undefined") return;
  ivory = read();
  document.documentElement.classList.toggle("ivory", ivory);
}

export function toggleTheme(): void {
  ivory = !ivory;
  document.documentElement.classList.toggle("ivory", ivory);
  try {
    localStorage.setItem(KEY, ivory ? "ivory" : "dark");
  } catch {
    /* private mode — לא נשמר בין ביקורים */
  }
  for (const fn of subscribers) fn();
}

/** true = שנהב (ברירת המחדל של hob, גם ב-SSR). */
export function useIvory(): boolean {
  return useSyncExternalStore(
    (fn) => {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    () => ivory,
    () => true,
  );
}
