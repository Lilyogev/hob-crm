// הערה בתוך טבלה (משימות, לידים, מכירות, חלוקות). בשורה רואים את ההתחלה שלה;
// לחיצה פותחת מעליה תיבה רחבה שגדלה עם הטקסט, כדי לראות ולערוך את כל ההערה
// התיבה צפה (position: fixed) כדי שטבלה עם גלילה לא תחתוך אותה.
// אותם props כמו EditableText, אז היא נכנסת במקומו בלי שינוי אחר.
//
// Enter שומר, Shift+Enter שורה חדשה, Esc מבטל, לחיצה מחוץ לתיבה שומרת.
// גלילה של הדף שומרת וסוגרת, כדי שהתיבה לא תישאר תלויה מעל שורה אחרת.
import { useEffect, useLayoutEffect, useRef, useState } from "react";

type Box = { right: number; width: number; top?: number; bottom?: number };

export function NoteCell({
  value,
  placeholder,
  className,
  onSave,
}: {
  value: string;
  placeholder?: string;
  className?: string;
  onSave: (v: string) => void;
}) {
  const [box, setBox] = useState<Box | null>(null);
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);
  const cancelled = useRef(false);

  const open = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(Math.max(r.width, 320), vw - 16);
    // RTL: the box keeps the cell's right edge, and never leaves the screen.
    const right = Math.min(Math.max(8, vw - r.right), vw - width - 8);
    // Near the bottom of the screen the box grows upward from the cell instead.
    const pos: Box = r.top > vh * 0.6 ? { right, width, bottom: vh - r.bottom } : { right, width, top: r.top };
    cancelled.current = false;
    setDraft(value);
    setBox(pos);
  };

  const grow = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.6)}px`;
  };

  useLayoutEffect(() => {
    if (!box) return;
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    grow();
  }, [box]);

  useEffect(() => {
    if (!box) return;
    const onScroll = (e: Event) => {
      // A long note scrolling inside its own box is not the page moving.
      if (e.target === ref.current) return;
      ref.current?.blur();
    };
    window.addEventListener("scroll", onScroll, true);
    return () => window.removeEventListener("scroll", onScroll, true);
  }, [box]);

  const close = () => {
    const next = draft.trim();
    setBox(null);
    if (!cancelled.current && next !== value) onSave(next);
  };

  return (
    <>
      <button
        type="button"
        onClick={(e) => open(e.currentTarget)}
        className={`h-9 w-full truncate px-3 text-start leading-9 hover:bg-[var(--hob-hover)] ${className ?? ""}`}
      >
        {value || <span className="text-[var(--hob-faint)]">{placeholder ?? ""}</span>}
      </button>
      {box && (
        <textarea
          ref={ref}
          value={draft}
          rows={1}
          onChange={(e) => {
            setDraft(e.target.value);
            grow();
          }}
          onBlur={close}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              ref.current?.blur();
            }
            if (e.key === "Escape") {
              cancelled.current = true;
              ref.current?.blur();
            }
          }}
          style={{ position: "fixed", ...box }}
          className={`z-50 min-h-9 resize-none rounded-md border-2 border-[var(--hob-accent)] bg-[var(--hob-surface)] px-3 py-2 leading-5 text-[var(--hob-ink)] shadow-lg outline-none ${className ?? ""}`}
        />
      )}
    </>
  );
}
