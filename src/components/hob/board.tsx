import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Suspense, lazy, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { OWNER_LABEL, PARTNER, type Partner } from "../../lib/partners";
import { setDemo, useDemo } from "./demo";
import { toggleTheme } from "./theme";
import { toast } from "./toast";
import { NoteCell } from "./note-cell";

// Each tool tab is its own chunk, fetched on first visit (__root.tsx reloads
// once if a chunk 404s after a deploy), so opening the task board on a phone
// never downloads the stock and finance views first.
const SeedingView = lazy(() => import("./seeding").then((m) => ({ default: m.SeedingView })));
const FinanceView = lazy(() => import("./finance").then((m) => ({ default: m.FinanceView })));
const InfluencersView = lazy(() => import("./influencers").then((m) => ({ default: m.InfluencersView })));
const AssistantChatView = lazy(() => import("./assistant-chat").then((m) => ({ default: m.AssistantChatView })));
const SettingsView = lazy(() => import("./settings").then((m) => ({ default: m.SettingsView })));
const TodayView = lazy(() => import("./today").then((m) => ({ default: m.TodayView })));

/** The logged-in partner, from /api/me. Kept in React state, never in localStorage. */
export type BoardUser = { key: Partner; name: string };

// ---- Types (mirror of the API) ----

export type Task = {
  id: number;
  group_id: number;
  title: string;
  notes: string;
  status: string;
  priority: string;
  owner: string;
  due_date: string;
  position: number;
  updated_at: string;
};

export type Group = {
  id: number;
  /** 'shared' | 'avia' | 'lior': the task tab that shows this group. */
  view: string;
  title: string;
  color: string;
  position: number;
  tasks: Task[];
  /** משימות בארכיון בקבוצה. הן עצמן נטענות רק כשפותחים את הארכיון. */
  archived_count?: number;
};

// ---- Vocabulary (Monday-style colors the partners already know) ----

const STATUS: Record<string, { label: string; bg: string; fg: string }> = {
  not_started: { label: "לא התחיל", bg: "#c4c4c4", fg: "#ffffff" },
  working: { label: "בעבודה", bg: "#fdab3d", fg: "#ffffff" },
  stuck: { label: "תקוע", bg: "#e2445c", fg: "#ffffff" },
  done: { label: "בוצע", bg: "#00c875", fg: "#ffffff" },
  // Not offered in the status dropdown — set via the move menu's archive action.
  archived: { label: "בארכיון", bg: "#676879", fg: "#ffffff" },
};
const STATUS_ORDER = ["not_started", "working", "stuck", "done"];

const PRIORITY: Record<string, { label: string; bg: string; fg: string }> = {
  "": { label: "—", bg: "#f1f2f7", fg: "#676879" },
  high: { label: "גבוהה", bg: "#401694", fg: "#ffffff" },
  medium: { label: "בינונית", bg: "#5559df", fg: "#ffffff" },
  low: { label: "נמוכה", bg: "#579bfc", fg: "#ffffff" },
};
const PRIORITY_ORDER = ["high", "medium", "low", ""];

// Task owner: one partner, both of them, or nobody yet (vocabulary from partners.ts).
const OWNER: Record<string, { label: string; short: string; bg: string }> = {
  "": { label: OWNER_LABEL[""], short: "?", bg: "#c4c4c4" },
  avia: { label: PARTNER.avia.label, short: PARTNER.avia.letter, bg: PARTNER.avia.color },
  lior: { label: PARTNER.lior.label, short: PARTNER.lior.letter, bg: PARTNER.lior.color },
  both: { label: OWNER_LABEL.both, short: `${PARTNER.avia.letter}+${PARTNER.lior.letter}`, bg: "#00a359" },
};
const OWNER_ORDER: string[] = ["avia", "lior", "both", ""];

// The task tabs. Which groups each one shows comes from the server: every
// board_groups row carries its view ('shared' | 'avia' | 'lior').
const TASK_VIEWS: { key: string; label: string }[] = [
  { key: "shared", label: "משותף" },
  { key: "avia", label: PARTNER.avia.label },
  { key: "lior", label: PARTNER.lior.label },
];

// ---- API helpers ----

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (res.status === 401) throw new Error("unauthorized");
  if (!res.ok) throw new Error(`request failed: ${res.status}`);
  return (await res.json()) as T;
}

export function post(url: string, body: unknown): Promise<unknown> {
  return api(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---- Utilities ----

export function todayISO(): string {
  const d = new Date();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

export function formatHebDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return iso;
  return `${Number(d)}.${Number(m)}.${y.slice(2)}`;
}

// Auto-sort inside a group: priority first (high → low → none), then the
// earliest due date (empty dates last), then the original manual order.
const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2, "": 3 };

function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const p = (PRIORITY_RANK[a.priority] ?? 3) - (PRIORITY_RANK[b.priority] ?? 3);
    if (p !== 0) return p;
    if (a.due_date !== b.due_date) {
      if (!a.due_date) return 1;
      if (!b.due_date) return -1;
      return a.due_date < b.due_date ? -1 : 1;
    }
    return a.position - b.position || a.id - b.id;
  });
}

// Done tasks untouched for a week sink into the collapsed archive, so the
// "בוצעו" section only shows this week's wins. updated_at comes from D1 as
// UTC "YYYY-MM-DD HH:MM:SS".
const ARCHIVE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

function isArchived(t: Task): boolean {
  if (!t.updated_at) return false;
  const ts = Date.parse(`${t.updated_at.replace(" ", "T")}Z`);
  return Number.isFinite(ts) && Date.now() - ts > ARCHIVE_AFTER_MS;
}

// Optimistic updates must keep the same timestamp format D1 produces.
function nowStamp(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

// Dependency-free confetti burst, fired when a task is marked done.
export function fireConfetti() {
  if (typeof document === "undefined") return;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  const colors = ["#00c875", "#0073ea", "#fdab3d", "#e2445c", "#a25ddc", "#ffcb00"];
  const layer = document.createElement("div");
  layer.style.cssText =
    "position:fixed;inset:0;pointer-events:none;z-index:100;overflow:hidden";
  document.body.appendChild(layer);
  const cx = window.innerWidth / 2;
  const cy = window.innerHeight * 0.35;
  for (let i = 0; i < 90; i++) {
    const piece = document.createElement("div");
    const size = 5 + Math.random() * 6;
    piece.style.cssText = `position:absolute;left:${cx}px;top:${cy}px;width:${size}px;height:${size * 1.6}px;background:${colors[i % colors.length]};border-radius:1px`;
    layer.appendChild(piece);
    const angle = Math.random() * Math.PI * 2;
    const distance = 120 + Math.random() * Math.min(cx, 380);
    const dx = Math.cos(angle) * distance;
    const dy = Math.sin(angle) * distance * 0.7 - 80;
    piece.animate(
      [
        { transform: "translate(0,0) rotate(0deg)", opacity: 1 },
        {
          transform: `translate(${dx}px,${dy + 320}px) rotate(${Math.random() * 720 - 360}deg)`,
          opacity: 0,
        },
      ],
      { duration: 1100 + Math.random() * 700, easing: "cubic-bezier(.15,.65,.35,1)" },
    );
  }
  setTimeout(() => layer.remove(), 1900);
}

// ---- Small building blocks ----

// Fixed-position menu so it never gets clipped by the group table's
// overflow container; opens upward when there is no room below.
export type MenuPos = { left: number; top?: number; bottom?: number };

export function menuPosFor(el: HTMLElement, itemCount: number): MenuPos {
  const r = el.getBoundingClientRect();
  const estHeight = itemCount * 38 + 6;
  const pos: MenuPos = { left: Math.max(8, r.left + r.width / 2 - 65) };
  if (r.bottom + estHeight > window.innerHeight - 8) {
    pos.bottom = window.innerHeight - r.top + 4;
  } else {
    pos.top = r.bottom + 4;
  }
  return pos;
}

export function Dropdown({
  pos,
  onClose,
  children,
}: {
  pos: MenuPos | null;
  onClose: () => void;
  children: ReactNode;
}) {
  if (!pos) return null;
  return (
    <>
      <div className="fixed inset-0 z-30" onClick={onClose} />
      <div
        style={{ position: "fixed", ...pos }}
        className="z-40 max-h-[60vh] min-w-[130px] overflow-y-auto overflow-x-hidden rounded-lg border border-[var(--hob-rule-strong)] bg-[var(--hob-surface)] shadow-lg"
      >
        {children}
      </div>
    </>
  );
}

export function PillCell({
  value,
  vocab,
  order,
  onChange,
  rounded,
}: {
  value: string;
  vocab: Record<string, { label: string; bg: string; fg: string }>;
  order: string[];
  onChange: (v: string) => void;
  rounded?: boolean;
}) {
  const [pos, setPos] = useState<MenuPos | null>(null);
  const current = vocab[value] ?? vocab[order[0]];
  return (
    <div className="relative h-full w-full">
      <button
        type="button"
        onClick={(e) =>
          setPos((p) => (p ? null : menuPosFor(e.currentTarget, order.length)))
        }
        className={`flex h-9 w-full items-center justify-center text-sm font-medium transition-transform active:scale-[0.98] ${rounded ? "rounded-md" : ""}`}
        style={{ backgroundColor: current.bg, color: current.fg }}
      >
        {current.label}
      </button>
      <Dropdown pos={pos} onClose={() => setPos(null)}>
        {order.map((key) => (
          <button
            key={key || "none"}
            type="button"
            onClick={() => {
              onChange(key);
              setPos(null);
            }}
            className="block w-full px-3 py-2 text-center text-sm font-medium hover:opacity-90"
            style={{ backgroundColor: vocab[key].bg, color: vocab[key].fg }}
          >
            {vocab[key].label}
          </button>
        ))}
      </Dropdown>
    </div>
  );
}

function OwnerCell({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [pos, setPos] = useState<MenuPos | null>(null);
  const current = OWNER[value] ?? OWNER[""];
  return (
    <div className="relative flex h-full w-full items-center justify-center">
      <button
        type="button"
        onClick={(e) =>
          setPos((p) => (p ? null : menuPosFor(e.currentTarget, OWNER_ORDER.length)))
        }
        title={current.label}
        className="flex h-9 w-full items-center justify-center gap-1.5"
      >
        <span
          className="flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-semibold text-white"
          style={{ backgroundColor: current.bg }}
        >
          {current.short}
        </span>
      </button>
      <Dropdown pos={pos} onClose={() => setPos(null)}>
        {OWNER_ORDER.map((key) => (
          <button
            key={key || "none"}
            type="button"
            onClick={() => {
              onChange(key);
              setPos(null);
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-sm text-[var(--hob-ink)] hover:bg-[var(--hob-hover)]"
          >
            <span
              className="flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-semibold text-white"
              style={{ backgroundColor: OWNER[key].bg }}
            >
              {OWNER[key].short}
            </span>
            {OWNER[key].label}
          </button>
        ))}
      </Dropdown>
    </div>
  );
}

// People type money with commas ("23,312") — parseFloat alone stops at the
// comma and silently saves 23; Number("1,430") is NaN and the edit vanishes.
// Strip everything that isn't part of a number before parsing.
export function parseMoney(raw: string): number {
  return parseFloat(String(raw).replace(/[^\d.-]/g, ""));
}

export function EditableText({
  value,
  placeholder,
  className,
  onSave,
  inputMode,
}: {
  value: string;
  placeholder?: string;
  className?: string;
  onSave: (v: string) => void;
  /** "numeric" / "decimal" opens the number pad on phones and keeps digits LTR. */
  inputMode?: "numeric" | "decimal";
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          setDraft(value);
          setEditing(true);
        }}
        className={`h-9 w-full truncate px-3 text-start leading-9 hover:bg-[var(--hob-hover)] ${className ?? ""}`}
      >
        {value || <span className="text-[var(--hob-faint)]">{placeholder ?? ""}</span>}
      </button>
    );
  }
  const commit = () => {
    setEditing(false);
    if (draft.trim() !== value) onSave(draft.trim());
  };
  return (
    <input
      ref={inputRef}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setEditing(false);
      }}
      inputMode={inputMode}
      dir={inputMode ? "ltr" : undefined}
      className={`h-9 w-full border-2 border-[var(--hob-accent)] bg-[var(--hob-surface)] px-3 outline-none ${className ?? ""}`}
    />
  );
}

function DateCell({
  value,
  status,
  onChange,
}: {
  value: string;
  status: string;
  onChange: (v: string) => void;
}) {
  const overdue =
    Boolean(value) && value < todayISO() && status !== "done" && status !== "archived";
  return (
    <div className="relative h-9 w-full">
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onClick={(e) => {
          // Desktop browsers focus the invisible input without opening the
          // calendar popup — open it explicitly (mobile opens it natively).
          try {
            (e.currentTarget as HTMLInputElement & { showPicker?: () => void }).showPicker?.();
          } catch {
            // NotAllowedError etc. — fall back to native focus behavior.
          }
        }}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        aria-label="תאריך יעד"
      />
      <div
        className={`hob-mono pointer-events-none flex h-full w-full items-center justify-center text-[12.5px] ${
          overdue ? "font-semibold text-[#e2445c]" : "text-[var(--hob-ink)]"
        }`}
      >
        {value ? (
          <span>
            {overdue ? "⚠ " : ""}
            {formatHebDate(value)}
          </span>
        ) : (
          <span className="text-[var(--hob-faint)]">＋ תאריך</span>
        )}
      </div>
    </div>
  );
}

// Tap alternative to drag & drop (drag doesn't exist on touch screens):
// a small menu that moves the task to another group in the current view,
// plus manual archive / restore.
function MoveButton({
  targets,
  archived,
  onSelect,
  onArchive,
  onRestore,
}: {
  targets: { id: number; title: string; color: string }[];
  archived: boolean;
  onSelect: (groupId: number) => void;
  onArchive: () => void;
  onRestore: () => void;
}) {
  const [pos, setPos] = useState<MenuPos | null>(null);
  return (
    <div className="relative flex items-center justify-center">
      <button
        type="button"
        title="העברה לקבוצה אחרת או לארכיון"
        onClick={(e) =>
          setPos((p) => (p ? null : menuPosFor(e.currentTarget, targets.length + 1)))
        }
        className="rounded p-1.5 text-[var(--hob-faint)] opacity-60 transition-opacity hover:bg-[var(--hob-hover)] hover:text-[var(--hob-accent)] sm:opacity-0 sm:group-hover:opacity-100"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M8 3L4 7l4 4M4 7h16M16 21l4-4-4-4M20 17H4" />
        </svg>
      </button>
      <Dropdown pos={pos} onClose={() => setPos(null)}>
        {targets.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => {
              onSelect(t.id);
              setPos(null);
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-start text-sm text-[var(--hob-ink)] hover:bg-[var(--hob-hover)]"
          >
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: t.color }}
            />
            {t.title}
          </button>
        ))}
        {archived ? (
          <button
            type="button"
            onClick={() => {
              onRestore();
              setPos(null);
            }}
            className="flex w-full items-center gap-2 border-t border-[var(--hob-rule)] px-3 py-2 text-start text-sm text-[var(--hob-ink)] hover:bg-[var(--hob-hover)]"
          >
            ↩ החזרה ללוח
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              onArchive();
              setPos(null);
            }}
            className="flex w-full items-center gap-2 border-t border-[var(--hob-rule)] px-3 py-2 text-start text-sm text-[var(--hob-soft)] hover:bg-[var(--hob-hover)]"
          >
            🗄 העברה לארכיון
          </button>
        )}
      </Dropdown>
    </div>
  );
}

export function DeleteButton({ onConfirm }: { onConfirm: () => void }) {
  const [arming, setArming] = useState(false);

  if (arming) {
    return (
      <div className="relative flex items-center justify-center">
        <div className="fixed inset-0 z-30" onClick={() => setArming(false)} />
        <button
          type="button"
          onClick={() => {
            setArming(false);
            onConfirm();
          }}
          className="z-40 rounded-md bg-[#e2445c] px-2 py-1 text-xs font-medium text-white hover:bg-[#c93a4f]"
        >
          למחוק?
        </button>
      </div>
    );
  }
  return (
    <div className="flex items-center justify-center">
      <button
        type="button"
        onClick={() => setArming(true)}
        title="מחיקת משימה"
        className="rounded p-1.5 text-[var(--hob-faint)] opacity-60 transition-opacity hover:bg-[var(--hob-hover)] hover:text-[#e2445c] sm:opacity-0 sm:group-hover:opacity-100"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M3 6h18M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z" />
        </svg>
      </button>
    </div>
  );
}

// ---- Grid layout shared by header + rows ----

const GRID =
  "grid grid-cols-[minmax(230px,2fr)_minmax(170px,1.4fr)_120px_90px_110px_120px_72px] items-stretch";

function TaskRow({
  task,
  color,
  moveTargets,
  onPatch,
  onDelete,
  onMove,
}: {
  task: Task;
  color: string;
  moveTargets: { id: number; title: string; color: string }[];
  onPatch: (id: number, patch: Partial<Task>) => void;
  onDelete: (id: number) => void;
  onMove: (id: number, groupId: number) => void;
}) {
  return (
    <div
      // Anchor for deep links: /?tab=shared#task-<id>
      id={`task-${task.id}`}
      draggable
      data-task-row
      onDragStart={(e) => {
        // Don't hijack text selection inside an editing input.
        if ((e.target as HTMLElement).tagName === "INPUT") {
          e.preventDefault();
          return;
        }
        e.dataTransfer.setData("text/plain", String(task.id));
        e.dataTransfer.effectAllowed = "move";
      }}
      className={`${GRID} group border-b border-[var(--hob-rule)] bg-[var(--hob-surface)] text-sm text-[var(--hob-ink)] last:border-b-0`}
      style={{ borderInlineStart: `5px solid ${color}` }}
    >
      <div className="flex items-stretch border-e border-[var(--hob-rule)]">
        {/* ידית גרירה. כל תא בשורה הוא <button>, ובספארי ובפיירפוקס גרירה לא
            מתחילה מתוך כפתור, אז הגרירה של השורה עבדה רק בכרום. הידית היא span
            רגיל עם draggable משלו, ותמונת הגרירה היא השורה כולה. */}
        <span
          draggable
          role="img"
          aria-label="גרירה לקבוצה אחרת"
          title="גרור לקבוצה אחרת"
          onDragStart={(e) => {
            e.stopPropagation();
            e.dataTransfer.setData("text/plain", String(task.id));
            e.dataTransfer.effectAllowed = "move";
            const row = e.currentTarget.closest("[data-task-row]");
            if (row) e.dataTransfer.setDragImage(row, 24, 18);
          }}
          className="hidden w-6 flex-none cursor-grab select-none items-center justify-center text-[13px] leading-none text-[var(--hob-faint)] opacity-50 hover:opacity-100 active:cursor-grabbing sm:flex"
        >
          ⋮⋮
        </span>
        <div className="min-w-0 flex-1">
          <EditableText
            value={task.title}
            onSave={(v) => v && onPatch(task.id, { title: v })}
            className={task.status === "done" ? "text-[var(--hob-faint)] line-through" : ""}
          />
        </div>
      </div>
      <div className="border-e border-[var(--hob-rule)]">
        <NoteCell
          value={task.notes}
          placeholder="＋ הערה"
          className="text-[13px] text-[var(--hob-soft)]"
          onSave={(v) => onPatch(task.id, { notes: v })}
        />
      </div>
      <div className="border-e border-[var(--hob-rule)]">
        <PillCell
          value={task.status}
          vocab={STATUS}
          order={STATUS_ORDER}
          onChange={(v) => onPatch(task.id, { status: v })}
        />
      </div>
      <div className="border-e border-[var(--hob-rule)]">
        <OwnerCell value={task.owner} onChange={(v) => onPatch(task.id, { owner: v })} />
      </div>
      <div className="border-e border-[var(--hob-rule)]">
        <PillCell
          value={task.priority}
          vocab={PRIORITY}
          order={PRIORITY_ORDER}
          onChange={(v) => onPatch(task.id, { priority: v })}
        />
      </div>
      <div className="border-e border-[var(--hob-rule)]">
        <DateCell
          value={task.due_date}
          status={task.status}
          onChange={(v) => onPatch(task.id, { due_date: v })}
        />
      </div>
      <div className="flex items-center justify-center">
        <MoveButton
          targets={moveTargets.filter((t) => t.id !== task.group_id)}
          archived={task.status === "archived"}
          onSelect={(groupId) => onMove(task.id, groupId)}
          onArchive={() => onPatch(task.id, { status: "archived" })}
          onRestore={() => onPatch(task.id, { status: "not_started" })}
        />
        <DeleteButton onConfirm={() => onDelete(task.id)} />
      </div>
    </div>
  );
}

// Phone layout: one compact card per task instead of the wide table row,
// so the board never needs sideways scrolling on a small screen.
function TaskCard({
  task,
  color,
  moveTargets,
  onPatch,
  onDelete,
  onMove,
}: {
  task: Task;
  color: string;
  moveTargets: { id: number; title: string; color: string }[];
  onPatch: (id: number, patch: Partial<Task>) => void;
  onDelete: (id: number) => void;
  onMove: (id: number, groupId: number) => void;
}) {
  return (
    <div
      className="group rounded-lg border border-[var(--hob-rule)] bg-[var(--hob-surface)] p-2.5 shadow-sm"
      style={{ borderInlineStart: `5px solid ${color}` }}
    >
      <div className="flex items-start gap-1">
        <div className="min-w-0 flex-1">
          <EditableText
            value={task.title}
            onSave={(v) => v && onPatch(task.id, { title: v })}
            className={`rounded-md font-medium ${
              task.status === "done" ? "text-[var(--hob-faint)] line-through" : ""
            }`}
          />
        </div>
        <MoveButton
          targets={moveTargets.filter((t) => t.id !== task.group_id)}
          archived={task.status === "archived"}
          onSelect={(groupId) => onMove(task.id, groupId)}
          onArchive={() => onPatch(task.id, { status: "archived" })}
          onRestore={() => onPatch(task.id, { status: "not_started" })}
        />
        <DeleteButton onConfirm={() => onDelete(task.id)} />
      </div>
      <NoteCell
        value={task.notes}
        placeholder="＋ הערה"
        className="rounded-md text-[13px] text-[var(--hob-soft)]"
        onSave={(v) => onPatch(task.id, { notes: v })}
      />
      <div className="mt-1.5 grid grid-cols-2 gap-1.5">
        <PillCell
          value={task.status}
          vocab={STATUS}
          order={STATUS_ORDER}
          rounded
          onChange={(v) => onPatch(task.id, { status: v })}
        />
        <PillCell
          value={task.priority}
          vocab={PRIORITY}
          order={PRIORITY_ORDER}
          rounded
          onChange={(v) => onPatch(task.id, { priority: v })}
        />
        <div className="rounded-md border border-[var(--hob-rule)]">
          <OwnerCell value={task.owner} onChange={(v) => onPatch(task.id, { owner: v })} />
        </div>
        <div className="rounded-md border border-[var(--hob-rule)]">
          <DateCell
            value={task.due_date}
            status={task.status}
            onChange={(v) => onPatch(task.id, { due_date: v })}
          />
        </div>
      </div>
    </div>
  );
}

function AddTaskRow({ groupId, onAdd }: { groupId: number; onAdd: (groupId: number, title: string) => void }) {
  const [value, setValue] = useState("");
  const submit = () => {
    const v = value.trim();
    if (!v) return;
    onAdd(groupId, v);
    setValue("");
  };
  return (
    <div className="flex items-center gap-2 border-t border-[var(--hob-rule)] bg-[var(--hob-surface)] px-3 py-1.5"
      style={{ borderInlineStart: "5px solid transparent" }}>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        placeholder="＋ הוספת משימה"
        className="h-8 w-full max-w-sm rounded-md border border-transparent px-2 text-sm outline-none placeholder:text-[var(--hob-faint)] focus:border-[var(--hob-accent)]"
      />
      {value.trim() && (
        <button
          type="button"
          onClick={submit}
          className="rounded-md bg-[var(--hob-accent)] px-3 py-1 text-sm font-bold text-[var(--hob-accent-fg)] hover:bg-[var(--hob-accent-hover)]"
        >
          הוספה
        </button>
      )}
    </div>
  );
}

function TableHeader() {
  return (
    <div
      className={`${GRID} border-b border-[var(--hob-rule-strong)] bg-[var(--hob-bg2)] text-center text-[13px] font-medium text-[var(--hob-soft)]`}
      style={{ borderInlineStart: "5px solid transparent" }}
    >
      <div className="border-e border-[var(--hob-rule)] py-2 ps-3 text-start">משימה</div>
      <div className="border-e border-[var(--hob-rule)] py-2 ps-3 text-start">הערות</div>
      <div className="border-e border-[var(--hob-rule)] py-2">סטטוס</div>
      <div className="border-e border-[var(--hob-rule)] py-2">אחראי</div>
      <div className="border-e border-[var(--hob-rule)] py-2">עדיפות</div>
      <div className="border-e border-[var(--hob-rule)] py-2">תאריך יעד</div>
      <div />
    </div>
  );
}

function GroupSection({
  group,
  tasks,
  statsLabel,
  moveTargets,
  onPatch,
  onDelete,
  onAdd,
  onMove,
}: {
  group: Group;
  tasks: Task[];
  statsLabel: string;
  moveTargets: { id: number; title: string; color: string }[];
  onPatch: (id: number, patch: Partial<Task>) => void;
  onDelete: (id: number) => void;
  onAdd: (groupId: number, title: string) => void;
  onMove: (id: number, groupId: number) => void;
}) {
  // Empty groups start collapsed (header line only) so the board isn't a
  // scroll through seven empty weekday tables. Tapping the header expands —
  // and the add-task row is right there.
  const [collapsed, setCollapsed] = useState(tasks.length === 0);
  const [dragOver, setDragOver] = useState(false);
  return (
    <section
      className="mb-7"
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const id = Number(e.dataTransfer.getData("text/plain"));
        if (id) onMove(id, group.id);
      }}
    >
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="mb-1.5 flex items-center gap-2 text-base font-semibold"
        style={{ color: group.color }}
      >
        <span
          className={`inline-block transition-transform ${collapsed ? "-rotate-90" : ""}`}
          aria-hidden
        >
          ▾
        </span>
        {group.title}
        <span className="hob-mono text-[11px] font-normal text-[var(--hob-faint)]">{statsLabel}</span>
      </button>
      {!collapsed && (
        <div className="space-y-2 sm:hidden">
          {tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              color={group.color}
              moveTargets={moveTargets}
              onPatch={onPatch}
              onDelete={onDelete}
              onMove={onMove}
            />
          ))}
          <div className="overflow-hidden rounded-lg border border-[var(--hob-rule)] bg-[var(--hob-surface)]">
            <AddTaskRow groupId={group.id} onAdd={onAdd} />
          </div>
        </div>
      )}
      {!collapsed && (
        <div
          className={`hidden overflow-x-auto rounded-lg border shadow-sm transition-colors sm:block ${
            dragOver ? "border-[var(--hob-accent)] ring-2 ring-[var(--hob-accent)]/30" : "border-[var(--hob-rule-strong)]"
          }`}
        >
          <div className="min-w-[880px]">
            <TableHeader />
            {tasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                color={group.color}
                moveTargets={moveTargets}
                onPatch={onPatch}
                onDelete={onDelete}
                onMove={onMove}
              />
            ))}
            <AddTaskRow groupId={group.id} onAdd={onAdd} />
          </div>
        </div>
      )}
    </section>
  );
}

// Tasks whose status is "done", pulled out of their groups automatically.
// Changing a task's status here puts it straight back in its original group.
// Used twice: recent completions ("בוצעו") and the weekly archive.
function DoneSection({
  title,
  titleClass,
  subtitle,
  defaultCollapsed,
  onToggle,
  items,
  moveTargets,
  onPatch,
  onDelete,
  onMove,
}: {
  title: string;
  titleClass: string;
  subtitle: string;
  defaultCollapsed?: boolean;
  /** נקרא בכל פתיחה/סגירה (true = נפתח). הארכיון טוען את המשימות שלו רק בפתיחה. */
  onToggle?: (open: boolean) => void;
  items: { task: Task; color: string }[];
  moveTargets: { id: number; title: string; color: string }[];
  onPatch: (id: number, patch: Partial<Task>) => void;
  onDelete: (id: number) => void;
  onMove: (id: number, groupId: number) => void;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed ?? false);
  return (
    <section className="mb-7">
      <button
        type="button"
        onClick={() => {
          onToggle?.(collapsed);
          setCollapsed(!collapsed);
        }}
        className={`mb-1.5 flex items-center gap-2 text-base font-semibold ${titleClass}`}
      >
        <span
          className={`inline-block transition-transform ${collapsed ? "-rotate-90" : ""}`}
          aria-hidden
        >
          ▾
        </span>
        {title}
        <span className="text-xs font-normal text-[var(--hob-faint)]">{subtitle}</span>
      </button>
      {!collapsed && (
        <div className="space-y-2 sm:hidden">
          {items.map(({ task, color }) => (
            <TaskCard
              key={task.id}
              task={task}
              color={color}
              moveTargets={moveTargets}
              onPatch={onPatch}
              onDelete={onDelete}
              onMove={onMove}
            />
          ))}
        </div>
      )}
      {!collapsed && (
        <div className="hidden overflow-x-auto rounded-lg border border-[var(--hob-rule-strong)] shadow-sm sm:block">
          <div className="min-w-[880px]">
            <TableHeader />
            {items.map(({ task, color }) => (
              <TaskRow
                key={task.id}
                task={task}
                color={color}
                moveTargets={moveTargets}
                onPatch={onPatch}
                onDelete={onDelete}
                onMove={onMove}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

// ---- The board ----

// Deep-linkable tabs: /?tab=finance opens straight into כספים, refresh keeps
// the current tab, and Hobi can attach exact links in her messages.
// The tool tabs, in nav order. Adding a tab = one entry here plus its view below.
const TOOL_TABS = [
  { key: "stock", label: "📦 מלאי" },
  { key: "finance", label: "💰 כספים" },
  { key: "collab", label: "🤝 משפיענים" },
  { key: "hobi", label: "🤖 הובי" },
  { key: "settings", label: "⚙️ הגדרות" },
] as const;
const DEFAULT_TAB = "shared";
const TAB_KEYS: string[] = [...TASK_VIEWS.map((v) => v.key), ...TOOL_TABS.map((t) => t.key)];
const isTaskView = (view: string) => TASK_VIEWS.some((v) => v.key === view);

function TabFallback() {
  return <div className="py-24 text-center text-[var(--hob-faint)]">טוען…</div>;
}

function viewFromURL(): string {
  if (typeof window === "undefined") return DEFAULT_TAB;
  const t = new URLSearchParams(window.location.search).get("tab") ?? "";
  return t && TAB_KEYS.includes(t) ? t : DEFAULT_TAB;
}

// After a new version the board reloads on its own only after a long absence (see updateReady).
const LONG_AWAY_MS = 10 * 60_000;

export function HobBoard({ user, onAuthLost }: { user: BoardUser; onAuthLost: () => void }) {
  const queryClient = useQueryClient();
  const [view, setViewState] = useState(viewFromURL);
  // The actor everywhere is the logged-in partner's key. The API ignores any
  // client-sent actor and reads it from the session, so this is display only.
  const actor = user.key;
  // Phones: the two-row nav eats a third of the screen, so it slides away
  // while scrolling down and comes back on the first scroll up. Other views
  // that stack sticky bars under it listen for "hob-nav".
  const [navHidden, setNavHidden] = useState(false);
  useEffect(() => {
    let last = window.scrollY;
    let hidden = false;
    const onScroll = () => {
      const y = window.scrollY;
      const small = window.innerWidth < 640;
      const next = small && y > 80 && y > last + 4 ? true : y < last - 4 || y <= 80 || !small ? false : hidden;
      last = y;
      if (next !== hidden) {
        hidden = next;
        setNavHidden(next);
        window.dispatchEvent(new CustomEvent("hob-nav", { detail: { hidden: next } }));
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  const setView = (v: string) => {
    setViewState(v);
    const url = new URL(window.location.href);
    if (v === DEFAULT_TAB) url.searchParams.delete("tab");
    else url.searchParams.set("tab", v);
    window.history.replaceState(null, "", url);
  };

  // The board is polled every 30 seconds only while a task tab is open and the
  // screen is visible (refetchIntervalInBackground off: a phone in a pocket
  // pulls nothing). Coming back to the screen refreshes at once.
  // Archived tasks are not sent here; they load only when the archive opens.
  const taskTab = isTaskView(view);
  const boardQuery = useQuery({
    queryKey: ["board"],
    queryFn: () => api<{ ok: boolean; groups: Group[]; v?: string }>("/api/board"),
    enabled: taskTab,
    refetchInterval: taskTab ? 30_000 : false,
    refetchIntervalInBackground: false,
    retry: (count, error) => (error as Error).message !== "unauthorized" && count < 2,
  });
  const [showArchived, setShowArchived] = useState(false);
  // ["board", "archived"]: every invalidate of ["board"] (a task change) refreshes it too.
  const archivedQuery = useQuery({
    queryKey: ["board", "archived"],
    queryFn: () => api<{ ok: boolean; groups: Group[] }>("/api/board?archived=1"),
    enabled: showArchived && taskTab,
    retry: false,
  });
  // Version check on the other tabs: a few bytes every 2 minutes, not the whole board.
  const versionQuery = useQuery({
    queryKey: ["board-version"],
    queryFn: () => api<{ ok: boolean; v?: string }>("/api/board?only=v"),
    enabled: !taskTab,
    refetchInterval: 120_000,
    refetchIntervalInBackground: false,
    retry: false,
  });

  // A new deploy changes the server's build stamp. A visible page is never
  // reloaded under the user; a small "רענון" pill offers it, and the page
  // reloads on its own only after a long absence (the tab hidden LONG_AWAY_MS).
  const [updateReady, setUpdateReady] = useState(false);
  useEffect(() => {
    const serverV = taskTab ? boardQuery.data?.v : versionQuery.data?.v;
    if (!serverV || serverV === __BUILD_ID__) return;
    setUpdateReady(true);
  }, [boardQuery.data, versionQuery.data, taskTab]);
  useEffect(() => {
    if (!updateReady) return;
    let hiddenAt = document.hidden ? Date.now() : 0;
    let timer = document.hidden ? window.setTimeout(() => window.location.reload(), LONG_AWAY_MS) : 0;
    const onVis = () => {
      if (document.hidden) {
        hiddenAt = Date.now();
        window.clearTimeout(timer);
        timer = window.setTimeout(() => window.location.reload(), LONG_AWAY_MS);
        return;
      }
      window.clearTimeout(timer);
      // A phone that slept through the timer wakes up here instead.
      if (hiddenAt && Date.now() - hiddenAt >= LONG_AWAY_MS) window.location.reload();
      hiddenAt = 0;
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [updateReady]);

  // The badge on Hobi's tab = unread messages in the thread (digests, sale
  // alerts, reminders). What was read is kept per device (localStorage). The
  // count comes from /api/assistant/chat?count=1; a route that does not
  // answer it yet (404) just means no badge.
  const [hobiSeen, setHobiSeen] = useState<number>(() => {
    try {
      return Number(localStorage.getItem("hob_hobi_seen") || 0);
    } catch {
      return 0;
    }
  });
  const hobiUnreadQuery = useQuery({
    queryKey: ["hobi-unread", hobiSeen],
    queryFn: () => api<{ ok: boolean; unread?: number }>(`/api/assistant/chat?count=1&after=${hobiSeen}`).catch((e: Error) => (e.message === "unauthorized" ? Promise.reject(e) : { ok: false, unread: 0 })),
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    enabled: view !== "hobi",
    retry: false,
  });
  const hobiUnread = view === "hobi" ? 0 : (hobiUnreadQuery.data?.unread ?? 0);
  const markHobiSeen = (maxId: number) => {
    if (maxId <= hobiSeen) return;
    setHobiSeen(maxId);
    try {
      localStorage.setItem("hob_hobi_seen", String(maxId));
    } catch {
      /* private mode: the badge just stays session-local */
    }
  };

  useEffect(() => {
    const errs = [boardQuery.error, versionQuery.error, hobiUnreadQuery.error];
    if (errs.some((e) => e && (e as Error).message === "unauthorized")) onAuthLost();
  }, [boardQuery.error, versionQuery.error, hobiUnreadQuery.error, onAuthLost]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["board"] });

  const patchMutation = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: Partial<Task> }) => post("/api/task/update", { id, patch }),
    onMutate: async ({ id, patch }) => {
      await queryClient.cancelQueries({ queryKey: ["board"] });
      queryClient.setQueryData<{ ok: boolean; groups: Group[] }>(["board"], (old) => {
        if (!old) return old;
        const stamped = { ...patch, updated_at: nowStamp() };
        const moved = old.groups.flatMap((g) => g.tasks).find((t) => t.id === id);
        return {
          ...old,
          groups: old.groups.map((g) => {
            // A group_id patch moves the task between group arrays right away.
            if (typeof patch.group_id === "number") {
              const tasks = g.tasks.filter((t) => t.id !== id);
              if (g.id === patch.group_id && moved) tasks.push({ ...moved, ...stamped });
              return { ...g, tasks };
            }
            return { ...g, tasks: g.tasks.map((t) => (t.id === id ? { ...t, ...stamped } : t)) };
          }),
        };
      });
    },
    onSuccess: () => toast("נשמר ✓"),
    onSettled: invalidate,
  });

  const addMutation = useMutation({
    mutationFn: ({ groupId, title }: { groupId: number; title: string }) => post("/api/task/add", { groupId, title }),
    onSuccess: () => toast("המשימה נוספה ✓"),
    onSettled: invalidate,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => post("/api/task/del", { id }),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: ["board"] });
      queryClient.setQueryData<{ ok: boolean; groups: Group[] }>(["board"], (old) =>
        old ? { ...old, groups: old.groups.map((g) => ({ ...g, tasks: g.tasks.filter((t) => t.id !== id) })) } : old,
      );
    },
    onSuccess: () => toast("המשימה נמחקה"),
    onSettled: invalidate,
  });

  const { sections, doneItems, archivedItems, archivedTotal } = useMemo(() => {
    const raw = boardQuery.data?.groups ?? [];
    // Data-driven views: the groups whose `view` is the current tab, in board order.
    const viewGroups = raw.filter((g) => g.view === view);
    // Archived tasks come from a separate request, only after the archive was opened.
    const archivedById = new Map((archivedQuery.data?.groups ?? []).map((g) => [g.id, g.tasks]));
    const sections: { group: Group; tasks: Task[]; statsLabel: string }[] = [];
    const doneItems: { task: Task; color: string }[] = [];
    const archivedItems: { task: Task; color: string }[] = [];
    let archivedTotal = 0;
    for (const g of viewGroups) {
      const hiddenArchived = g.archived_count ?? 0;
      for (const t of g.tasks) {
        if (t.status === "archived") {
          // Only after an optimistic update (just archived); a normal load does not return these.
          archivedItems.push({ task: t, color: g.color });
          archivedTotal++;
        } else if (t.status === "done") {
          if (isArchived(t)) {
            archivedItems.push({ task: t, color: g.color });
            archivedTotal++;
          } else doneItems.push({ task: t, color: g.color });
        }
      }
      archivedTotal += hiddenArchived;
      for (const t of archivedById.get(g.id) ?? []) {
        // An optimistic update can leave an old copy: a task already back on the board is not shown twice.
        if (t.status === "archived" && !g.tasks.some((x) => x.id === t.id)) archivedItems.push({ task: t, color: g.color });
      }
      const total = g.tasks.length + hiddenArchived;
      const doneCount = g.tasks.filter((t) => t.status === "done" || t.status === "archived").length + hiddenArchived;
      sections.push({
        group: g,
        tasks: sortTasks(g.tasks.filter((t) => t.status !== "done" && t.status !== "archived")),
        statsLabel: total > 0 ? `${doneCount}/${total} בוצעו` : "אין משימות",
      });
    }
    const newestFirst = (a: { task: Task }, b: { task: Task }) => (a.task.updated_at < b.task.updated_at ? 1 : -1);
    doneItems.sort(newestFirst);
    archivedItems.sort(newestFirst);
    return { sections, doneItems, archivedItems, archivedTotal };
  }, [boardQuery.data, archivedQuery.data, view]);

  const demoOn = useDemo();
  const logout = async () => {
    try {
      await post("/api/logout", {});
    } finally {
      onAuthLost();
    }
  };

  const handleDelete = (id: number) => deleteMutation.mutate(id);

  const handlePatch = (id: number, patch: Partial<Task>) => {
    if (patch.status === "done") fireConfetti();
    patchMutation.mutate({ id, patch });
  };

  const handleMove = (id: number, groupId: number) => {
    const current = boardQuery.data?.groups.find((g) => g.tasks.some((t) => t.id === id));
    if (current?.id === groupId) return;
    patchMutation.mutate({ id, patch: { group_id: groupId } });
  };

  // A task can be moved to any group on the board, not only in the current tab
  // (that is how it goes from "משותף" to one partner's list). Current tab first.
  const moveTargets = useMemo(() => {
    const all = boardQuery.data?.groups ?? [];
    const label = (g: Group) => (g.view === view ? g.title : `${g.title} · ${TASK_VIEWS.find((v) => v.key === g.view)?.label ?? g.view}`);
    return [...all.filter((g) => g.view === view), ...all.filter((g) => g.view !== view)].map((g) => ({ id: g.id, title: label(g), color: g.color }));
  }, [boardQuery.data, view]);

  // Tab style in the top bar. The bar is always the brown --hob-nav in both
  // themes, so the text colors are literal on purpose.
  const topTab = (active: boolean) =>
    `flex-none whitespace-nowrap rounded-lg px-3 py-1.5 text-[13.5px] font-semibold transition-colors ${
      active ? "bg-[#faf6e9] font-extrabold text-[#4f463c]" : "text-[#e8dfcc] hover:bg-white/10 hover:text-white"
    }`;
  const ghostBtn = "flex-none rounded-lg px-2.5 py-1.5 text-[13.5px] text-[#e8dfcc] transition-colors hover:bg-white/10 hover:text-white";
  const hebToday = new Intl.DateTimeFormat("he-IL", { weekday: "long", day: "numeric", month: "numeric" }).format(new Date());

  return (
    <>
      {updateReady && (
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-full bg-[var(--hob-nav)] px-3 py-1.5 text-[12px] text-white shadow-lg ring-1 ring-white/20"
        >
          גרסה חדשה · רענון
        </button>
      )}
      {/* Phones: wrap to two visible rows so no tab hides in a sideways scroll. Desktop keeps one row. */}
      <nav
        className={`sticky top-0 z-40 flex flex-wrap items-center gap-1 bg-[var(--hob-nav)] px-3 py-1.5 transition-transform duration-200 sm:h-12 sm:flex-nowrap sm:overflow-x-auto sm:py-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${
          navHidden ? "-translate-y-full sm:translate-y-0" : ""
        }`}
      >
        <img src="/assets/hob-logo-light.png" alt="hob" className="h-[20px] w-auto flex-none pe-2" />
        {TASK_VIEWS.map((v) => (
          <button key={v.key} type="button" onClick={() => setView(v.key)} className={topTab(view === v.key)}>
            {v.label}
          </button>
        ))}
        <span className="mx-1 h-[18px] w-px flex-none bg-white/15" aria-hidden />
        {TOOL_TABS.map((t) => (
          <button key={t.key} type="button" onClick={() => setView(t.key)} className={topTab(view === t.key)}>
            {t.label}
            {t.key === "hobi" && hobiUnread > 0 && (
              <span className="hob-mono ms-1.5 inline-flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-[#e2445c] px-1 text-[10.5px] font-bold text-white">
                {hobiUnread > 9 ? "9+" : hobiUnread}
              </span>
            )}
          </button>
        ))}
        <span className="min-w-2 flex-1" aria-hidden />
        <span className="hidden flex-none items-center gap-1.5 pe-1 text-[12.5px] text-[#e8dfcc] sm:flex" title="מחוברת">
          <span className="flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold text-white" style={{ backgroundColor: PARTNER[user.key].color }}>
            {PARTNER[user.key].letter}
          </span>
          {user.name}
        </span>
        <button type="button" onClick={toggleTheme} title="כהה / בהיר" className={ghostBtn}>
          🌓
        </button>
        <button
          type="button"
          onClick={() => setDemo(!demoOn)}
          title="מצב הדגמה: מטשטש את מספרי העסק"
          className={demoOn ? "flex-none rounded-lg bg-[#fdab3d] px-2.5 py-1.5 text-[13.5px] font-bold text-[#14142b]" : ghostBtn}
        >
          🥷
        </button>
        <button type="button" onClick={logout} className={ghostBtn}>
          יציאה
        </button>
      </nav>
      <div className="mx-auto max-w-6xl px-4 pb-24 pt-4 sm:px-6">
        <div className="mb-5 flex items-center justify-between gap-3">
          <div className="text-xs text-[var(--hob-faint)]">
            <b className="font-semibold text-[var(--hob-soft)]">{hebToday}</b>
          </div>
          <div className="text-xs text-[var(--hob-faint)] sm:hidden">{user.name}</div>
        </div>

        <Suspense fallback={<TabFallback />}>
          {/* "היום שלכן" sits at the top of every task tab: what needs handling and the next action. */}
          {taskTab && <TodayView onAuthLost={onAuthLost} />}

          {view === "stock" && <SeedingView actor={actor} onAuthLost={onAuthLost} />}

          {view === "finance" && <FinanceView actor={actor} onAuthLost={onAuthLost} />}

          {view === "collab" && <InfluencersView onAuthLost={onAuthLost} />}

          {view === "hobi" && <AssistantChatView actor={actor} onAuthLost={onAuthLost} onSeen={markHobiSeen} />}

          {view === "settings" && <SettingsView user={user} onAuthLost={onAuthLost} />}
        </Suspense>

        {taskTab && boardQuery.isLoading && <div className="py-24 text-center text-[var(--hob-faint)]">טוען את הלוח…</div>}
        {taskTab && boardQuery.isError && !boardQuery.data && (boardQuery.error as Error).message !== "unauthorized" && (
          <div className="py-24 text-center text-[#e2445c]">שגיאה בטעינת הלוח. נסו לרענן את הדף.</div>
        )}
        {/* A failed 30s poll on flaky cellular is routine: with data on screen it gets a quiet hint. */}
        {taskTab && boardQuery.isError && !!boardQuery.data && (boardQuery.error as Error).message !== "unauthorized" && (
          <div className="mb-2 text-center text-[12px] text-[#e0a13c]">אין חיבור כרגע. מנסים שוב ברקע…</div>
        )}

        {taskTab && boardQuery.data && sections.length === 0 && (
          <div className="py-16 text-center text-sm text-[var(--hob-faint)]">אין קבוצות בטאב הזה.</div>
        )}

        {taskTab &&
          sections.map(({ group, tasks, statsLabel }) => (
            <GroupSection
              key={group.id}
              group={group}
              tasks={tasks}
              statsLabel={statsLabel}
              moveTargets={moveTargets}
              onPatch={handlePatch}
              onDelete={handleDelete}
              onAdd={(groupId, title) => addMutation.mutate({ groupId, title })}
              onMove={handleMove}
            />
          ))}

        {taskTab && (doneItems.length > 0 || archivedTotal > 0) && (
          <div className="mt-12">
            {doneItems.length > 0 && (
              <DoneSection
                title="✓ בוצעו"
                titleClass="text-[var(--hob-good)]"
                subtitle={`${doneItems.length} משימות שהושלמו השבוע. שינוי סטטוס מחזיר אותן לקבוצה שלהן`}
                items={doneItems}
                moveTargets={moveTargets}
                onPatch={handlePatch}
                onDelete={handleDelete}
                onMove={handleMove}
              />
            )}
            {archivedTotal > 0 && (
              <DoneSection
                title="🗄 ארכיון"
                titleClass="text-[var(--hob-soft)]"
                subtitle={`${archivedTotal} משימות · הועברו ידנית או בוצעו לפני יותר משבוע${showArchived && archivedQuery.isFetching && !archivedQuery.data ? " · טוען…" : ""}`}
                defaultCollapsed
                onToggle={(open) => open && setShowArchived(true)}
                items={archivedItems}
                moveTargets={moveTargets}
                onPatch={handlePatch}
                onDelete={handleDelete}
                onMove={handleMove}
              />
            )}
          </div>
        )}

        <footer dir="ltr" className="mt-10 text-center text-[10.5px] uppercase tracking-[0.22em] text-[var(--hob-faint)]">
          House of Bais
        </footer>
      </div>
    </>
  );
}
