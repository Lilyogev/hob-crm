import { useMemo, useState } from "react";
import { PillCell } from "../board";
import { HANDLED_BY, HANDLED_BY_ORDER, LocDot, type SeedSale, Shs } from "./shared";

// Orders waiting to ship, computed from the ledger already in memory: every
// live line (recorded / packed, not pop-up, not archive) grouped by order
// reference the way orders.server does it (order_ref, or the row itself when
// there is none). Status moves per order through sale_update on all its ids.

const DELIVERY: Record<string, string> = { "": "לא צוין", ship: "משלוח", pickup: "איסוף", hand: "ביד" };
const DELIVERY_ORDER = ["ship", "pickup", "hand"];

type OrderRow = {
  key: string;
  ref: string;
  buyer: string;
  phone: string;
  address: string;
  soldAt: string;
  status: "recorded" | "packed";
  delivery: string;
  handledBy: string;
  lines: SeedSale[];
  ids: number[];
  total: number;
  days: number;
};

function orderKey(s: SeedSale): { key: string; ref: string } {
  const ref = (s.order_ref || /Shopify\s+(#\d{3,6})/.exec(s.note || "")?.[1] || "").trim();
  return ref ? { key: `order:${ref}`, ref } : { key: `row:${s.id}`, ref: "" };
}

function daysSince(day: string): number {
  const t = Date.parse(`${day.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(t)) return 0;
  const today = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  return Math.max(0, Math.floor((today - t) / 86400000));
}

export function groupOpenOrders(sales: SeedSale[]): OrderRow[] {
  const groups = new Map<string, SeedSale[]>();
  for (const s of sales) {
    if (s.channel === "popup" || s.channel === "archive") continue;
    if (s.ship_status !== "recorded" && s.ship_status !== "packed") continue;
    const { key } = orderKey(s);
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  const out: OrderRow[] = [];
  for (const [key, lines] of groups) {
    const first = lines[0];
    out.push({
      key,
      ref: orderKey(first).ref,
      buyer: first.buyer || "בלי שם",
      phone: first.buyer_phone,
      address: first.buyer_address,
      soldAt: first.sold_at,
      status: lines.every((l) => l.ship_status === "packed") ? "packed" : "recorded",
      delivery: first.delivery || "",
      handledBy: first.handled_by || "",
      lines,
      ids: lines.map((l) => l.id),
      total: lines.reduce((a, l) => a + l.price * l.qty, 0),
      days: daysSince(first.sold_at),
    });
  }
  // Oldest first: the order that waited longest is the one to pack now.
  return out.sort((a, b) => b.days - a.days || a.buyer.localeCompare(b.buyer, "he"));
}

export function OrdersPanel({ sales, act }: { sales: SeedSale[]; act: (body: Record<string, unknown>) => void }) {
  const orders = useMemo(() => groupOpenOrders(sales), [sales]);
  const [open, setOpen] = useState(true);
  if (!orders.length) return null;
  const late = orders.filter((o) => o.days > 2).length;
  return (
    <div className="mb-3 rounded-lg border border-[var(--hob-rule-strong)] bg-[var(--hob-surface)] p-3 shadow-sm">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 text-sm font-semibold text-[var(--hob-ink)]">
        <span className={`inline-block text-[10px] transition-transform ${open ? "" : "-rotate-90"}`} aria-hidden>
          ▾
        </span>
        🚚 הזמנות למשלוח
        <span className="dm text-xs font-normal text-[var(--hob-faint)]">
          {orders.length} פתוחות{late ? ` · ${late} מחכות יותר מיומיים` : ""}
        </span>
      </button>
      {open && (
        <div className="mt-2 space-y-1.5">
          {orders.map((o) => (
            <div
              key={o.key}
              className="rounded-md border border-[var(--hob-rule)] bg-[var(--hob-bg2)] p-2 text-[13px]"
              style={{ borderInlineStart: `4px solid ${o.days > 2 ? "#e2445c" : o.status === "packed" ? "#fdab3d" : "#c4c4c4"}` }}
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <b className="dm text-[var(--hob-ink)]">{o.buyer}</b>
                {o.ref && <span className="dm text-[11px] text-[var(--hob-faint)]" dir="ltr">{o.ref}</span>}
                <span className="dm text-[11px] text-[var(--hob-faint)]">{o.days === 0 ? "היום" : `לפני ${o.days} ימים`}</span>
                <span className="ms-auto font-semibold text-[var(--hob-good)]">{Shs(o.total)}</span>
              </div>
              <div className="dm mt-0.5 text-[12px] text-[var(--hob-soft)]">
                {o.lines.map((l) => (
                  <span key={l.id} className="me-2 inline-flex items-center gap-1">
                    <LocDot loc={l.location} />
                    {l.item_label}
                    {l.size ? ` ${l.size}` : ""}
                    {l.qty > 1 ? ` ×${l.qty}` : ""}
                  </span>
                ))}
              </div>
              {(o.address || o.phone) && (
                <div className="dm mt-0.5 truncate text-[11.5px] text-[var(--hob-faint)]">
                  {o.address}
                  {o.address && o.phone ? " · " : ""}
                  <span dir="ltr">{o.phone}</span>
                </div>
              )}
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <div className="flex overflow-hidden rounded-md border border-[var(--hob-rule)]">
                  {DELIVERY_ORDER.map((d) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => act({ action: "sale_update", ids: o.ids, patch: { delivery: d } })}
                      className={`px-2 py-1 text-[11.5px] ${o.delivery === d ? "bg-[var(--hob-accent)] font-semibold text-white" : "bg-[var(--hob-surface)] text-[var(--hob-soft)] hover:bg-[var(--hob-hover)]"}`}
                    >
                      {DELIVERY[d]}
                    </button>
                  ))}
                </div>
                <div className="w-24 overflow-hidden rounded-md" title="מי מטפלת">
                  <PillCell value={o.handledBy} vocab={HANDLED_BY} order={HANDLED_BY_ORDER} rounded onChange={(v) => act({ action: "sale_update", ids: o.ids, patch: { handled_by: v } })} />
                </div>
                <div className="ms-auto flex gap-1.5">
                  {o.status === "recorded" && (
                    <button
                      type="button"
                      onClick={() => act({ action: "sale_update", ids: o.ids, patch: { ship_status: "packed" } })}
                      className="rounded-md bg-[#fdab3d] px-2.5 py-1 text-[12px] font-semibold text-white hover:opacity-90"
                    >
                      📦 ארוז
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => act({ action: "sale_update", ids: o.ids, patch: { ship_status: "shipped" } })}
                    className="rounded-md bg-[#579bfc] px-2.5 py-1 text-[12px] font-semibold text-white hover:opacity-90"
                  >
                    🚚 נשלח
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
