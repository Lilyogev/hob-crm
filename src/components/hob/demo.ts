// Demo mode — the 🥷 toggle in the header. Two layers: the money formatters
// (NIS in finance, ILS in seeding) return ••• while demo is on, so real
// amounts never enter the DOM (F12 / copy-paste shows nothing); the CSS blur
// on .dm/.dm-block stays as a second net for prose the formatters miss.
// Toggling reloads the page so every view re-renders with the new state.
// useDemo() remains only for the toggle button's own active styling.
import { useSyncExternalStore } from "react";

const KEY = "hob_demo";
const BODY_CLASS = "hob-demo";

let on = false;
try {
  on = localStorage.getItem(KEY) === "1";
} catch {
  // private mode / storage blocked — demo mode just won't persist
}
if (typeof document !== "undefined") document.body.classList.toggle(BODY_CLASS, on);

const subscribers = new Set<() => void>();

function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

export const isDemo = (): boolean => on;

export function setDemo(next: boolean): void {
  on = next;
  if (typeof document !== "undefined") document.body.classList.toggle(BODY_CLASS, next);
  try {
    localStorage.setItem(KEY, next ? "1" : "0");
  } catch {
    // ignore
  }
  for (const fn of subscribers) fn();
  // The money formatters read isDemo() at render time — a full reload is the
  // simple way to make every view re-render with the new state.
  if (typeof window !== "undefined") window.location.reload();
}

/** Subscribe to demo-mode changes (used by the header toggle). SSR is always false. */
export function useDemo(): boolean {
  return useSyncExternalStore(subscribe, isDemo, () => false);
}
