import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type DragEvent, type KeyboardEvent } from "react";
import { isDemo } from "../demo";

import {
  DeleteButton,
  Dropdown,
  EditableText,
  PillCell,
  api,
  formatHebDate,
  menuPosFor,
  parseMoney,
  post,
  todayISO,
  type MenuPos,
} from "../board";
// Shekel amounts. In demo mode (🥷) body.hob-demo CSS smears every .dm span.
import { POPUP_BUYER, PopupMode } from "./PopupMode";
import { AddGiftForm, AddItemRow, AddLineInline, AddSaleForm, ArchiveToggle, BUCKETS, BucketCell, COLLECTIONS, CollectionHeader, CollectionPicker, CustomerDetails, GIFT_COLOR, GIFT_RANK, GIFT_STATUS, GIFT_STATUS_ORDER, GroupTotalEdit, ILS, ITEM_COLOR, KindCell, compareKinds, kindStyle, saleGroupKey, LOCATIONS, PAY_METHOD, PAY_METHOD_ORDER, PopupBadge, QtyStepper, RepeatBadge, SALE_COLOR, SHIP_RANK, SHIP_STATUS, SHIP_STATUS_ORDER, SeedGift, SeedSale, SeedingData, Shs, SizePicker, StatsPanel, TransferInline, bucketSum, hasContact, itemCollection, itemTotal, rowTotal, stockAt } from "./shared";
import { NoteCell } from "../note-cell";

let consumedPopupSignal = 0;
export function SeedingView({
  actor,
  onAuthLost,
  popupSignal,
}: {
  actor: string;
  onAuthLost: () => void;
  // Bumped by the board's nav "פופ-אפ" button — each bump opens pop-up mode.
  popupSignal?: number;
}) {
  const queryClient = useQueryClient();

  const seedingQuery = useQuery({
    queryKey: ["seeding"],
    queryFn: () => api<SeedingData>("/api/seeding"),
    // 30s (was 12s): each poll returns the whole ledger — 12s was on course
    // to exceed D1's free daily read quota with two partners' tabs open.
    refetchInterval: 30_000,
    retry: (count, error) => (error as Error).message !== "unauthorized" && count < 2,
  });

  useEffect(() => {
    if (seedingQuery.error && (seedingQuery.error as Error).message === "unauthorized") {
      onAuthLost();
    }
  }, [seedingQuery.error, onAuthLost]);

  // Every mutation returns the fresh dataset — write it straight to the cache.
  const mutate = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      post("/api/seeding", { ...body, actor }) as Promise<SeedingData>,
    onSuccess: (data) => {
      if (data?.ok) queryClient.setQueryData(["seeding"], data);
    },
    // The response IS the fresh dataset — refetching on top of it downloaded
    // the whole ledger twice per tap. Refetch only when the save didn't
    // hand one back.
    onSettled: (data) => {
      if (!data?.ok) queryClient.invalidateQueries({ queryKey: ["seeding"] });
    },
  });
  const act = (body: Record<string, unknown>) => mutate.mutate(body);

  const items = seedingQuery.data?.items ?? [];
  const gifts = seedingQuery.data?.gifts ?? [];
  const sales = seedingQuery.data?.sales ?? [];

  // Archive rows (imported previous-drop orders) enrich the buyer-grouped log
  // and the repeat badge, but stay OUT of the current-drop numbers.
  const liveSales = useMemo(
    () => sales.filter((s) => s.channel !== "archive" && s.ship_status !== "cancelled"),
    [sales],
  );

  const totals = useMemo(() => {
    const inStock = items.reduce((s, i) => s + itemTotal(i), 0);
    const givenOut = items.reduce((s, i) => s + i.given, 0);
    const soldOut = liveSales.reduce((s, x) => s + x.qty, 0);
    const revenue = liveSales.reduce((s, x) => s + x.price * x.qty, 0);
    // People are counted separately for gifts vs sales, and de-duped by name so
    // a buyer of 2 items still counts as one person.
    const giftPeople = new Set(
      gifts.map((g) => g.person.trim().toLowerCase()).filter(Boolean),
    ).size;
    const salePeople = new Set(
      liveSales.map((x) => x.buyer.trim().toLowerCase()).filter(Boolean),
    ).size;
    return { inStock, givenOut, soldOut, revenue, giftPeople, salePeople };
  }, [items, gifts, liveSales]);

  // The stock screen is grouped by collection, and each group carries its own
  // three numbers — an empty group is dropped so a one-collection tracker
  // looks exactly like it did before groups existed.
  const itemGroups = useMemo(
    () =>
      COLLECTIONS.map((c) => {
        const rows = items.filter((i) => itemCollection(i) === c.key);
        return {
          ...c,
          rows,
          inStock: rows.reduce((s, i) => s + itemTotal(i), 0),
          given: rows.reduce((s, i) => s + i.given, 0),
          sold: rows.reduce((s, i) => s + i.sold, 0),
        };
      }).filter((g) => g.rows.length > 0),
    [items],
  );

  // The revenue tile opens into this: the same money split by where it landed.
  // Store orders are in the bank; Bit and cash are in someone's pocket.
  const moneyRows = useMemo(() => {
    const m = new Map<string, { amount: number; units: number }>();
    for (const s of liveSales) {
      const key = s.pay_method || "";
      const row = m.get(key) ?? { amount: 0, units: 0 };
      row.amount += s.price * s.qty;
      row.units += s.qty;
      m.set(key, row);
    }
    return ["shopify", "hyp", "bit", "cash", "transfer", ""]
      .map((key) => ({ key, ...(m.get(key) ?? { amount: 0, units: 0 }) }))
      .filter((r) => r.amount > 0);
  }, [liveSales]);

  // Pop-up slice of the same money — how much came from physical events and
  // how many people bought there. A named buyer counts once per event day;
  // anonymous quick-sales count per line (one line = one customer at the
  // stand, since the pop-up flow records a single item per tap).
  const popupStats = useMemo(() => {
    const rows = liveSales.filter((s) => s.channel === "popup");
    const people = new Set<string>();
    let anon = 0;
    for (const r of rows) {
      const name = r.buyer.trim();
      if (!name || name === POPUP_BUYER) anon++;
      else people.add(`${name}|${r.sold_at}`);
    }
    return {
      amount: rows.reduce((s, r) => s + r.price * r.qty, 0),
      buyers: people.size + anon,
      events: new Set(rows.map((r) => r.sold_at || "?")).size,
    };
  }, [liveSales]);

  // A multi-item gift/sale shows as ONE row: all lines of the same person are
  // grouped (dates were dropped from the UI). Shared-field edits + delete
  // apply to all line ids; per-line size/qty live in the expandable line list.
  const giftGroups = useMemo(() => {
    const map = new Map<string, SeedGift[]>();
    for (const g of gifts) {
      const k = g.person.trim();
      map.set(k, [...(map.get(k) ?? []), g]);
    }
    return [...map.entries()]
      .map(([key, rows]) => ({
        key,
        rows,
        ids: rows.map((r) => r.id),
      }))
      // Same kind stays together (changing a row's kind moves it next to its
      // new group), then by how far along the gift is.
      .sort(
        (a, b) =>
          compareKinds(a.rows[0].kind, b.rows[0].kind) ||
          (GIFT_RANK[a.rows[0].status || "promised"] ?? 0) -
            (GIFT_RANK[b.rows[0].status || "promised"] ?? 0),
      );
  }, [gifts]);

  // Grouping key: the buyer's name, disambiguated by a contact detail so two
  // different "דנה"s stay two rows (a shared edit or delete used to hit
  // both). Anonymous pop-up sales are never grouped: each line is its own
  // row — grouping them all under "פופ-אפ" once made one delete wipe every
  // anonymous stand sale ever recorded.
  const saleGroups = useMemo(() => {
    const map = new Map<string, SeedSale[]>();
    for (const s of sales) {
      const k = saleGroupKey(s, POPUP_BUYER);
      map.set(k, [...(map.get(k) ?? []), s]);
    }
    return [...map.entries()]
      .map(([key, rows]) => ({
        key,
        rows,
        ids: rows.map((r) => r.id),
      }))
      .sort(
        (a, b) =>
          (SHIP_RANK[a.rows[0].ship_status || "recorded"] ?? 0) -
          (SHIP_RANK[b.rows[0].ship_status || "recorded"] ?? 0),
      );
  }, [sales]);

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggle = (key: string) => setExpanded((e) => ({ ...e, [key]: !e[key] }));

  // Previous-drop buyers live behind a collapsible divider at the log's
  // bottom; the open/closed choice sticks per device.
  const [archiveOpen, setArchiveOpen] = useState<boolean>(() => {
    if (typeof localStorage === "undefined") return false;
    return localStorage.getItem("hob_arch_open") === "1";
  });
  const toggleArchive = () =>
    setArchiveOpen((v) => {
      const next = !v;
      try {
        localStorage.setItem("hob_arch_open", next ? "1" : "0");
      } catch {
        // Private-mode storage errors must not break the toggle.
      }
      return next;
    });
  const archiveGroups = useMemo(
    () => saleGroups.filter((g) => g.rows.every((r) => r.channel === "archive")),
    [saleGroups],
  );
  // What the log actually renders: current-drop buyers, then the divider
  // sentinel, then (only when open) the archive buyers.
  const displaySaleGroups = useMemo(() => {
    const current = saleGroups.filter((g) => g.rows.some((r) => r.channel !== "archive"));
    if (!archiveGroups.length) return current;
    const sentinel = { key: "__archive__", rows: [] as SeedSale[], ids: [] as number[] };
    return archiveOpen ? [...current, sentinel, ...archiveGroups] : [...current, sentinel];
  }, [saleGroups, archiveGroups, archiveOpen]);
  const [showMoney, setShowMoney] = useState(false);
  const [showStockSplit, setShowStockSplit] = useState(false);
  const [popupOpen, setPopupOpen] = useState(false);
  useEffect(() => {
    // Only a FRESH bump opens pop-up mode. The consumed counter lives at
    // module scope because this component unmounts on every tab switch — a
    // state/ref would forget what was already handled and re-open the popup
    // each time the seeding tab is entered.
    if (popupSignal && popupSignal > consumedPopupSignal) {
      consumedPopupSignal = popupSignal;
      setPopupOpen(true);
    }
  }, [popupSignal]);

  // "＋" on a person's row opens an inline add-line; the new gift line joins
  // their grouped row (grouping is by person) and stock updates as usual.
  const [addingFor, setAddingFor] = useState<string | null>(null);
  const addLineToPerson =
    (first: SeedGift) =>
    (line: { itemId: number; qty: number; size: string; location: string }) => {
      act({
        action: "gift_add",
        items: [{ itemId: line.itemId, qty: line.qty, size: line.size }],
        location: line.location,
        person: first.person,
        handle: first.handle,
        kind: first.kind,
        status: "given",
        givenAt: todayISO(),
        note: "",
      });
      setAddingFor(null);
    };

  // Drag & drop reorder (like tasks): drag a grouped row, drop on another row,
  // and the whole sequence is persisted.
  const [dragging, setDragging] = useState<{ kind: "gift" | "sale"; key: string } | null>(null);

  const dropOn = (kind: "gift" | "sale", targetIndex: number) => {
    if (!dragging || dragging.kind !== kind) return;
    const groups = kind === "gift" ? giftGroups : saleGroups;
    const fromIndex = groups.findIndex((g) => g.key === dragging.key);
    setDragging(null);
    if (fromIndex < 0 || fromIndex === targetIndex) return;
    const order = [...groups];
    const [moved] = order.splice(fromIndex, 1);
    order.splice(targetIndex, 0, moved);
    act({
      action: kind === "gift" ? "gift_reorder" : "sale_reorder",
      orders: order.map((g, k) => ({ ids: g.ids, position: k })),
    });
  };

  // Don't hijack text selection inside an editing input (same guard as tasks).
  const dragStart = (kind: "gift" | "sale", key: string) => (e: DragEvent) => {
    if ((e.target as HTMLElement).tagName === "INPUT") {
      e.preventDefault();
      return;
    }
    e.dataTransfer.effectAllowed = "move";
    setDragging({ kind, key });
  };

  if (seedingQuery.isLoading) {
    return <div className="py-24 text-center text-[var(--hob-faint)]">טוען את החלוקות…</div>;
  }
  if (seedingQuery.isError && !seedingQuery.data && (seedingQuery.error as Error).message !== "unauthorized") {
    return (
      <div className="py-24 text-center text-[#e2445c]">
        שגיאה בטעינת החלוקות — נסו לרענן את הדף.
      </div>
    );
  }

  return (
    <div>
      {popupOpen && (
        <PopupMode
          items={items}
          sales={sales}
          act={act}
          pending={mutate.isPending}
          onClose={() => setPopupOpen(false)}
        />
      )}
      {/* Totals strip */}
      <div className="mb-5 grid grid-cols-3 gap-2 sm:grid-cols-6">
        {[
          { label: "במלאי", value: totals.inStock, color: "#0073ea" },
          { label: "קיבלו (אנשים)", value: totals.giftPeople, color: "#a25ddc" },
          { label: "חולקו (מוצרים)", value: totals.givenOut, color: "#a25ddc" },
          { label: "קנו (אנשים)", value: totals.salePeople, color: "#00854d" },
          { label: "נמכרו (מוצרים)", value: totals.soldOut, color: "#00854d" },
          { label: "הכנסות", value: ILS(totals.revenue), color: "#00854d" },
        ].map((s) => {
          // Two tiles open: stock splits by collection, revenue splits by
          // where the money landed. The rest are plain numbers, so only these
          // two get the button affordance.
          const opensStock = s.label === "במלאי" && itemGroups.length > 1;
          const opensMoney = s.label === "הכנסות";
          const opens = opensStock || opensMoney;
          const isOpen = opensStock ? showStockSplit : showMoney;
          const toggleTile = opensStock
            ? () => setShowStockSplit((v) => !v)
            : () => setShowMoney((v) => !v);
          const ring = opensStock ? "#0073ea" : "#00854d";
          return (
            <div
              key={s.label}
              role={opens ? "button" : undefined}
              tabIndex={opens ? 0 : undefined}
              title={opensStock ? "לחיצה — מלאי לפי קולקציה" : opens ? "לחיצה — איפה הכסף" : undefined}
              onClick={opens ? toggleTile : undefined}
              onKeyDown={
                opens
                  ? (e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        toggleTile();
                      }
                    }
                  : undefined
              }
              className={`rounded-lg border bg-[var(--hob-surface)] px-3 py-2 text-center shadow-sm ${
                opens
                  ? `cursor-pointer transition-colors ${
                      opensStock ? "hover:border-[var(--hob-accent)]" : "hover:border-[var(--hob-good)]"
                    } ${isOpen ? "" : "border-[var(--hob-rule)]"}`
                  : "border-[var(--hob-rule)]"
              }`}
              style={opens && isOpen ? { borderColor: ring } : undefined}
            >
              <div className="text-xl font-bold dm" style={{ color: s.color }}>
                {s.value}
              </div>
              <div className="text-xs text-[var(--hob-soft)]">
                {s.label}
                {opens && <span className="ms-1 text-[10px]">{isOpen ? "▴" : "▾"}</span>}
              </div>
            </div>
          );
        })}
      </div>

      {/* Stock tile, opened: the same units split by collection. */}
      {showStockSplit && itemGroups.length > 1 && (
        <div className="-mt-3 mb-5 rounded-lg border border-[var(--hob-rule-strong)] bg-[var(--hob-surface)] p-3 shadow-sm">
          <div className="mb-2 flex items-baseline justify-between">
            <b className="text-sm text-[var(--hob-ink)]">📦 מלאי לפי קולקציה</b>
            <span className="text-[11px] text-[var(--hob-faint)]">מתוך {totals.inStock} יחידות</span>
          </div>
          <div className="space-y-1.5">
            {itemGroups.map((g) => (
              <div key={g.key} className="flex items-center gap-2">
                <span
                  className="w-28 shrink-0 rounded-md px-2 py-1 text-center text-[12px] font-medium text-white sm:w-32"
                  style={{ backgroundColor: g.color }}
                >
                  {g.short}
                </span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--hob-hover)]">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${Math.max(2, Math.round((g.inStock / Math.max(1, totals.inStock)) * 100))}%`,
                      backgroundColor: g.color,
                    }}
                  />
                </div>
                <span className="dm w-20 shrink-0 text-end text-[13px] text-[var(--hob-soft)]">
                  <b className="text-[var(--hob-ink)]">{g.inStock}</b> במלאי
                </span>
              </div>
            ))}
          </div>
          <div className="mt-2 text-[11px] leading-relaxed text-[var(--hob-faint)]">
            שיוך פריט לקולקציה משנים בשורה שלו בטבלת המלאי.
          </div>
        </div>
      )}

      {/* Revenue tile, opened: the same money split by where it landed. */}
      {showMoney && (
        <div className="-mt-3 mb-5 rounded-lg border border-[var(--hob-rule-strong)] bg-[var(--hob-surface)] p-3 shadow-sm">
          <div className="mb-2 flex items-baseline justify-between">
            <b className="text-sm text-[var(--hob-ink)]">💰 איפה הכסף</b>
            <span className="text-[11px] text-[var(--hob-faint)]">מתוך {Shs(totals.revenue)} הכנסות</span>
          </div>
          {moneyRows.length === 0 ? (
            <div className="py-2 text-center text-[13px] text-[var(--hob-faint)]">עוד אין מכירות</div>
          ) : (
            <div className="space-y-1.5">
              {moneyRows.map((r) => (
                <div key={r.key || "none"} className="flex items-center gap-2">
                  <span
                    className="w-28 shrink-0 rounded-md px-2 py-1 text-center text-[12px] font-medium text-white sm:w-32"
                    style={{ backgroundColor: PAY_METHOD[r.key].bg }}
                  >
                    {PAY_METHOD[r.key].label}
                  </span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--hob-hover)]">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.max(2, Math.round((r.amount / Math.max(1, totals.revenue)) * 100))}%`,
                        backgroundColor: PAY_METHOD[r.key].bg,
                      }}
                    />
                  </div>
                  <span className="w-24 shrink-0 text-end text-[13px] font-semibold text-[var(--hob-ink)]">
                    {Shs(r.amount)}
                  </span>
                </div>
              ))}
            </div>
          )}
          {popupStats.amount > 0 && (
            <div className="mt-2 border-t border-[var(--hob-hover)] pt-2">
              <div className="flex items-center gap-2">
                <span className="w-28 shrink-0 rounded-md bg-[#b45309] px-2 py-1 text-center text-[12px] font-medium text-white sm:w-32">
                  🎪 פופ-אפ
                </span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--hob-hover)]">
                  <div
                    className="h-full rounded-full bg-[#b45309]"
                    style={{
                      width: `${Math.max(2, Math.round((popupStats.amount / Math.max(1, totals.revenue)) * 100))}%`,
                    }}
                  />
                </div>
                <span className="w-24 shrink-0 text-end text-[13px] font-semibold text-[var(--hob-ink)]">
                  {Shs(popupStats.amount)}
                </span>
              </div>
              <div className="mt-1 text-[11px] text-[var(--hob-faint)] dm-block">
                {popupStats.buyers} קונים {popupStats.events === 1 ? "באירוע אחד" : `ב-${popupStats.events} אירועים`} —
                החלק מתוך ההכנסות שהגיע מדוכנים (הכסף עצמו נספר למעלה לפי ביט/מזומן/Hyp)
              </div>
            </div>
          )}
          <div className="mt-2 text-[11px] leading-relaxed text-[var(--hob-faint)]">
            🛍 שופיפיי = כבר בבנק · 📱 ביט ו-💵 מזומן = הכסף אצלך
            {moneyRows.some((r) => r.key === "") &&
              " · «לא סומן» — מכירות ידניות ישנות, אפשר לתייג בעמודת «תשלום» בטבלת המכירות"}
          </div>
        </div>
      )}

      <StatsPanel gifts={gifts} sales={sales} />

      {/* Inventory */}
      <section className="mb-7">
        <div
          className="mb-1.5 flex items-center gap-2 text-base font-semibold"
          style={{ color: ITEM_COLOR }}
        >
          📦 מלאי
          <span className="text-xs font-normal text-[var(--hob-faint)]">
            {items.length > 0 ? `${items.length} פריטים` : "הוסיפו את הפריטים שיש לכם לחלוקה"}
          </span>
        </div>

        {/* Mobile: cards, grouped by collection */}
        <div className="space-y-2 sm:hidden">
          {itemGroups.map((g) => (
            <div key={g.key} className="space-y-2">
              {itemGroups.length > 1 && (
                <CollectionHeader label={g.label} color={g.color} inStock={g.inStock} />
              )}
              {g.rows.map((i) => (
            <div
              key={i.id}
              className="group rounded-lg border border-[var(--hob-rule)] bg-[var(--hob-surface)] p-2.5 shadow-sm"
              style={{ borderInlineStart: `5px solid ${g.color}` }}
            >
              <div className="flex items-start gap-1">
                <div className="min-w-0 flex-1">
                  <EditableText
                    value={i.name}
                    onSave={(v) => v && act({ action: "item_update", id: i.id, patch: { name: v } })}
                    className="rounded-md font-medium"
                  />
                </div>
                <DeleteButton onConfirm={() => act({ action: "item_del", id: i.id })} />
              </div>
              <div className="mt-1 flex items-center gap-2 px-1 text-xs text-[var(--hob-soft)]">
                <span className="dm-block">
                  סה״כ: <b className="text-[var(--hob-ink)]">{itemTotal(i)}</b> · ניתנו: {i.given} ·
                  נמכרו: {i.sold} · מחיר:
                </span>
                <div className="w-16 rounded-md border border-[var(--hob-rule)]">
                  <EditableText
                    value={i.price ? String(i.price) : ""}
                    placeholder="₪"
                    className="dm text-center text-[13px]"
                    inputMode="decimal"
                      onSave={(v) => {
                      const p = parseMoney(v);
                      if (Number.isFinite(p) && p >= 0) {
                        act({ action: "item_update", id: i.id, patch: { price: p } });
                      }
                    }}
                  />
                </div>
                {itemGroups.length > 1 && (
                  <CollectionPicker
                    value={itemCollection(i)}
                    onChange={(v) =>
                      act({ action: "item_update", id: i.id, patch: { collection: v } })
                    }
                  />
                )}
              </div>
              <div className="mt-1.5 space-y-1">
                {LOCATIONS.map((l) => {
                  const row = stockAt(i, l.key);
                  const lk = `loc:${i.id}:${l.key}`;
                  const isOpen = Boolean(expanded[lk]);
                  return (
                    <div key={l.key} className="rounded-md border border-[var(--hob-rule)]">
                      <button
                        type="button"
                        onClick={() => toggle(lk)}
                        className="flex w-full items-center gap-2 px-2 py-1.5 text-[13px] text-[var(--hob-ink)]"
                      >
                        <span
                          className={`inline-block text-[9px] text-[var(--hob-faint)] transition-transform ${isOpen ? "" : "-rotate-90"}`}
                        >
                          ▾
                        </span>
                        {l.icon} {l.label}
                        <b className="ms-auto">{rowTotal(row)}</b>
                      </button>
                      {isOpen && (
                        <div className="border-t border-[var(--hob-hover)] p-1.5">
                          <div className="grid grid-cols-7 overflow-hidden rounded-md border border-[var(--hob-rule)]">
                            {BUCKETS.map((b) => (
                              <div key={b.col} className="border-e border-[var(--hob-rule)] last:border-e-0">
                                <div className="border-b border-[var(--hob-rule)] bg-[var(--hob-bg2)] py-0.5 text-center text-[10px] text-[var(--hob-soft)]">
                                  {b.col === "qty" ? "בלי" : b.label}
                                </div>
                                <BucketCell
                                  value={row[b.col]}
                                  onSave={(v) =>
                                    act({
                                      action: "stock_update",
                                      id: i.id,
                                      location: l.key,
                                      patch: { [b.col]: v },
                                    })
                                  }
                                />
                              </div>
                            ))}
                          </div>
                          <div className="mt-1.5">
                            <TransferInline
                              from={l.key}
                              onTransfer={(to, size, qty) =>
                                act({
                                  action: "stock_transfer",
                                  id: i.id,
                                  from: l.key,
                                  to,
                                  size,
                                  qty,
                                })
                              }
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
              ))}
            </div>
          ))}
          <div className="overflow-hidden rounded-lg border border-[var(--hob-rule)] bg-[var(--hob-surface)]">
            <AddItemRow onAdd={(name, size, qty) => act({ action: "item_add", name, size, qty })} />
          </div>
        </div>

        {/* Desktop: size-matrix table */}
        <div className="hidden overflow-x-auto rounded-lg border border-[var(--hob-rule-strong)] shadow-sm sm:block">
          <div className="min-w-[920px]">
            <div
              className="grid grid-cols-[minmax(190px,2fr)_76px_58px_58px_58px_58px_58px_58px_64px_60px_60px_64px_48px] border-b border-[var(--hob-rule-strong)] bg-[var(--hob-bg2)] text-center text-[13px] font-medium text-[var(--hob-soft)]"
              style={{ borderInlineStart: "5px solid transparent" }}
            >
              <div className="border-e border-[var(--hob-rule)] py-2 ps-3 text-start">פריט</div>
              {BUCKETS.map((b) => (
                <div key={b.col} className="border-e border-[var(--hob-rule)] py-2 text-xs leading-5">
                  {b.label}
                </div>
              ))}
              <div className="border-e border-[var(--hob-rule)] bg-[var(--hob-hover)] py-2">סה״כ</div>
              <div className="border-e border-[var(--hob-rule)] py-2">ניתנו</div>
              <div className="border-e border-[var(--hob-rule)] py-2">נמכרו</div>
              <div className="border-e border-[var(--hob-rule)] py-2">₪ מחיר</div>
              <div />
            </div>
            {itemGroups.map((g) => (
              <div key={g.key}>
                {itemGroups.length > 1 && (
                  <div
                    className="border-b border-[var(--hob-rule)] px-3 py-1.5"
                    style={{ borderInlineStart: `5px solid ${g.color}`, backgroundColor: `${g.color}14` }}
                  >
                    <div className="flex items-center justify-between text-[13px] font-medium" style={{ color: g.color }}>
                      <span>{g.label}</span>
                      <span className="dm text-[12px]">{g.inStock} במלאי</span>
                    </div>
                  </div>
                )}
                {g.rows.map((i) => {
              const ik = `item:${i.id}`;
              const isOpen = Boolean(expanded[ik]);
              return (
                <div key={i.id} className="border-b border-[var(--hob-rule)] last:border-b-0">
                  <div
                    className="group grid grid-cols-[minmax(190px,2fr)_76px_58px_58px_58px_58px_58px_58px_64px_60px_60px_64px_48px] items-stretch bg-[var(--hob-surface)] text-sm text-[var(--hob-ink)]"
                    style={{ borderInlineStart: `5px solid ${g.color}` }}
                  >
                    <div className="flex items-stretch border-e border-[var(--hob-rule)]">
                      <button
                        type="button"
                        onClick={() => toggle(ik)}
                        title="פתיחת המיקומים של הפריט"
                        className="flex items-center ps-2 text-[10px] text-[var(--hob-faint)] hover:text-[var(--hob-accent)]"
                      >
                        <span
                          className={`inline-block transition-transform ${isOpen ? "" : "-rotate-90"}`}
                        >
                          ▾
                        </span>
                      </button>
                      <div className="min-w-0 flex-1">
                        <EditableText
                          value={i.name}
                          onSave={(v) =>
                            v && act({ action: "item_update", id: i.id, patch: { name: v } })
                          }
                        />
                      </div>
                    </div>
                    {BUCKETS.map((b) => {
                      const n = bucketSum(i, b.col);
                      return (
                        <div
                          key={b.col}
                          className={`flex items-center justify-center border-e border-[var(--hob-rule)] text-sm ${
                            n < 0
                              ? "font-semibold text-[#e2445c]"
                              : n === 0
                                ? "text-[var(--hob-faint)]"
                                : "font-medium"
                          }`}
                        >
                          {n}
                        </div>
                      );
                    })}
                    <div
                      className={`dm flex items-center justify-center border-e border-[var(--hob-rule)] bg-[var(--hob-bg2)] font-bold ${
                        itemTotal(i) <= 0 ? "text-[#e2445c]" : "text-[var(--hob-ink)]"
                      }`}
                    >
                      {itemTotal(i)}
                    </div>
                    <div className="dm flex items-center justify-center border-e border-[var(--hob-rule)] text-[var(--hob-soft)]">
                      {i.given}
                    </div>
                    <div className="dm flex items-center justify-center border-e border-[var(--hob-rule)] font-medium text-[var(--hob-good)]">
                      {i.sold}
                    </div>
                    <div className="border-e border-[var(--hob-rule)]">
                      <EditableText
                        value={i.price ? String(i.price) : ""}
                        placeholder="₪"
                        className="dm text-center text-[13px]"
                        inputMode="decimal"
                          onSave={(v) => {
                          const p = parseMoney(v);
                          if (Number.isFinite(p) && p >= 0) {
                            act({ action: "item_update", id: i.id, patch: { price: p } });
                          }
                        }}
                      />
                    </div>
                    <div className="flex items-center justify-center">
                      <DeleteButton onConfirm={() => act({ action: "item_del", id: i.id })} />
                    </div>
                  </div>
                  {isOpen && itemGroups.length > 1 && (
                    <div
                      className="flex items-center gap-2 border-t border-[var(--hob-hover)] bg-[var(--hob-bg2)] py-1.5 ps-7 text-[12px] text-[var(--hob-soft)]"
                      style={{ borderInlineStart: "5px solid #e6e9f2" }}
                    >
                      קולקציה:
                      <CollectionPicker
                        value={itemCollection(i)}
                        onChange={(v) =>
                          act({ action: "item_update", id: i.id, patch: { collection: v } })
                        }
                      />
                    </div>
                  )}
                  {isOpen &&
                    LOCATIONS.map((l) => {
                      const row = stockAt(i, l.key);
                      const tk = `tr:${i.id}:${l.key}`;
                      return (
                        <div key={l.key}>
                          <div
                            className="grid grid-cols-[minmax(190px,2fr)_76px_58px_58px_58px_58px_58px_58px_64px_60px_60px_64px_48px] items-stretch border-t border-[var(--hob-hover)] bg-[var(--hob-bg2)] text-sm text-[var(--hob-ink)]"
                            style={{ borderInlineStart: "5px solid #e6e9f2" }}
                          >
                            <div className="flex items-center gap-1.5 border-e border-[var(--hob-rule)] ps-7 text-[13px]">
                              <span>
                                {l.icon} {l.label}
                              </span>
                            </div>
                            {BUCKETS.map((b) => (
                              <div key={b.col} className="border-e border-[var(--hob-rule)]">
                                <BucketCell
                                  value={row[b.col]}
                                  onSave={(v) =>
                                    act({
                                      action: "stock_update",
                                      id: i.id,
                                      location: l.key,
                                      patch: { [b.col]: v },
                                    })
                                  }
                                />
                              </div>
                            ))}
                            <div className="flex items-center justify-center border-e border-[var(--hob-rule)] font-medium text-[var(--hob-soft)]">
                              {rowTotal(row)}
                            </div>
                            <div className="col-span-3 flex items-center justify-center border-e border-[var(--hob-rule)]">
                              <button
                                type="button"
                                onClick={() => toggle(tk)}
                                className="rounded px-1.5 py-0.5 text-[11.5px] text-[var(--hob-accent)] hover:bg-[var(--hob-hover)]"
                              >
                                העברה ⇄
                              </button>
                            </div>
                            <div />
                          </div>
                          {expanded[tk] && (
                            <div className="border-t border-[var(--hob-hover)] bg-[var(--hob-bg2)] py-1.5 pe-2 ps-8">
                              <TransferInline
                                from={l.key}
                                onTransfer={(to, size, qty) => {
                                  act({
                                    action: "stock_transfer",
                                    id: i.id,
                                    from: l.key,
                                    to,
                                    size,
                                    qty,
                                  });
                                  toggle(tk);
                                }}
                              />
                            </div>
                          )}
                        </div>
                      );
                    })}
                </div>
              );
                })}
              </div>
            ))}
            <AddItemRow onAdd={(name, size, qty) => act({ action: "item_add", name, size, qty })} />
          </div>
        </div>
      </section>

      {/* Gift log */}
      <section className="mb-7">
        <div
          className="mb-1.5 flex items-center gap-2 text-base font-semibold"
          style={{ color: GIFT_COLOR }}
        >
          🎁 יומן חלוקות
          <span className="text-xs font-normal text-[var(--hob-faint)]">
            {gifts.length > 0
              ? [
                  `${giftGroups.length} חלוקות · ${gifts.length} פריטים`,
                  ...(() => {
                    const byStatus = (st: string) =>
                      giftGroups.filter((g) => (g.rows[0].status || "promised") === st).length;
                    const parts: string[] = [];
                    const promised = byStatus("promised");
                    const given = byStatus("given");
                    const posted = byStatus("story") + byStatus("posted");
                    if (promised) parts.push(`${promised} הובטחו`);
                    if (given) parts.push(`${given} ממתינים לפרסום`);
                    if (posted) parts.push(`${posted} פרסמו`);
                    return parts;
                  })(),
                ].join(" · ")
              : "כל מי שקיבל מוצר יופיע כאן"}
          </span>
        </div>

        <AddGiftForm
          items={items}
          onAdd={(g) => act({ action: "gift_add", ...g, note: "" })}
        />

        {/* Mobile: one card per person+date, item lines inside */}
        <div className="space-y-2 sm:hidden">
          {giftGroups.map(({ key, rows, ids }, gi) => {
            const first = rows[0];
            return (
              <div
                key={key}
                draggable
                onDragStart={dragStart("gift", key)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  dropOn("gift", gi);
                }}
                className="group rounded-lg border border-[var(--hob-rule)] bg-[var(--hob-surface)] p-2.5 shadow-sm"
                style={{ borderInlineStart: `5px solid ${kindStyle(first.kind).bg}` }}
              >
                <div className="flex items-start gap-1">
                  <div className="min-w-0 flex-1">
                    <EditableText
                      value={first.person}
                      onSave={(v) =>
                        v && act({ action: "gift_update", ids, patch: { person: v } })
                      }
                      className="rounded-md font-medium"
                    />
                  </div>
                  <DeleteButton onConfirm={() => act({ action: "gift_del", ids })} />
                </div>
                <div className="flex items-center gap-1">
                  <div className="min-w-0 flex-1">
                    <EditableText
                      value={first.handle}
                      placeholder="＋ @אינסטגרם"
                      className="rounded-md text-[13px] text-[var(--hob-soft)]"
                      onSave={(v) => act({ action: "gift_update", ids, patch: { handle: v } })}
                    />
                  </div>
                  {first.handle && (
                    <a
                      href={`https://instagram.com/${first.handle.replace(/^@/, "")}`}
                      target="_blank"
                      rel="noreferrer"
                      title="פתיחת הפרופיל באינסטגרם"
                      className="shrink-0 rounded-md bg-[#a25ddc]/15 px-2 py-1 text-[13px] font-medium text-[#a25ddc]"
                    >
                      אינסטגרם ↗
                    </a>
                  )}
                </div>
                <div className="mt-1 divide-y divide-[var(--hob-hover)] rounded-md border border-[var(--hob-rule)]">
                  {rows.map((g) => (
                    <div key={g.id} className="flex items-center gap-1.5 ps-2">
                      <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--hob-ink)]">
                        {g.item_label}
                      </span>
                      <div className="w-16 shrink-0">
                        <SizePicker
                          value={g.size}
                          onChange={(v) =>
                            act({ action: "gift_update", id: g.id, patch: { size: v } })
                          }
                        />
                      </div>
                      <div className="shrink-0">
                        <QtyStepper
                          value={g.qty}
                          onChange={(v) =>
                            v >= 1 && act({ action: "gift_update", id: g.id, patch: { qty: v } })
                          }
                        />
                      </div>
                      {rows.length > 1 && (
                        <DeleteButton onConfirm={() => act({ action: "gift_del", id: g.id })} />
                      )}
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => setAddingFor((k) => (k === key ? null : key))}
                    className="w-full py-1.5 text-center text-[13px] text-[var(--hob-accent)]"
                  >
                    ＋ הוספת פריט
                  </button>
                  {addingFor === key && (
                    <div className="p-1.5">
                      <AddLineInline items={items} onAdd={addLineToPerson(first)} />
                    </div>
                  )}
                </div>
                <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                  <KindCell
                    value={first.kind}
                    rounded
                    onChange={(v) => act({ action: "gift_update", ids, patch: { kind: v } })}
                  />
                  <PillCell
                    value={first.status}
                    vocab={GIFT_STATUS}
                    order={GIFT_STATUS_ORDER}
                    rounded
                    onChange={(v) => act({ action: "gift_update", ids, patch: { status: v } })}
                  />
                </div>
                <NoteCell
                  value={first.note}
                  placeholder="＋ הערה"
                  className="mt-1 rounded-md text-[13px] text-[var(--hob-soft)]"
                  onSave={(v) => act({ action: "gift_update", ids, patch: { note: v } })}
                />
              </div>
            );
          })}
        </div>

        {/* Desktop: table */}
        {gifts.length > 0 && (
          <div className="hidden overflow-x-auto rounded-lg border border-[var(--hob-rule-strong)] shadow-sm sm:block">
            <div className="min-w-[940px]">
              <div
                className="grid grid-cols-[minmax(150px,1.3fr)_minmax(130px,1fr)_110px_minmax(170px,1.4fr)_70px_64px_130px_minmax(130px,1fr)_44px] border-b border-[var(--hob-rule-strong)] bg-[var(--hob-bg2)] text-center text-[13px] font-medium text-[var(--hob-soft)]"
                style={{ borderInlineStart: "5px solid transparent" }}
              >
                <div className="border-e border-[var(--hob-rule)] py-2 ps-3 text-start">שם</div>
                <div className="border-e border-[var(--hob-rule)] py-2 ps-3 text-start">אינסטגרם</div>
                <div className="border-e border-[var(--hob-rule)] py-2">סוג</div>
                <div className="border-e border-[var(--hob-rule)] py-2 ps-3 text-start">פריט</div>
                <div className="border-e border-[var(--hob-rule)] py-2">מידה</div>
                <div className="border-e border-[var(--hob-rule)] py-2">כמות</div>
                <div className="border-e border-[var(--hob-rule)] py-2">סטטוס</div>
                <div className="border-e border-[var(--hob-rule)] py-2 ps-3 text-start">הערות</div>
                <div />
              </div>
              {giftGroups.map(({ key, rows, ids }, gi) => {
                const first = rows[0];
                const multi = rows.length > 1;
                const isOpen = Boolean(expanded[key]);
                const totalQty = rows.reduce((s, r) => s + r.qty, 0);
                return (
                  <div
                    key={key}
                    draggable
                    onDragStart={dragStart("gift", key)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      dropOn("gift", gi);
                    }}
                    className="border-b border-[var(--hob-rule)] last:border-b-0"
                  >
                    <div
                      className="group grid grid-cols-[minmax(150px,1.3fr)_minmax(130px,1fr)_110px_minmax(170px,1.4fr)_70px_64px_130px_minmax(130px,1fr)_44px] items-stretch bg-[var(--hob-surface)] text-sm text-[var(--hob-ink)]"
                      style={{
                        borderInlineStart: `5px solid ${kindStyle(first.kind).bg}`,
                      }}
                    >
                      <div className="border-e border-[var(--hob-rule)]">
                        <EditableText
                          value={first.person}
                          onSave={(v) =>
                            v && act({ action: "gift_update", ids, patch: { person: v } })
                          }
                        />
                      </div>
                      <div className="flex items-stretch border-e border-[var(--hob-rule)]" dir="ltr">
                        {first.handle && (
                          <a
                            href={`https://instagram.com/${first.handle.replace(/^@/, "")}`}
                            target="_blank"
                            rel="noreferrer"
                            title="פתיחת הפרופיל באינסטגרם"
                            className="flex items-center px-1.5 text-[13px] text-[#a25ddc] hover:text-[#8a3fc9]"
                          >
                            ↗
                          </a>
                        )}
                        <div className="min-w-0 flex-1">
                          <EditableText
                            value={first.handle}
                            placeholder="＋ @handle"
                            className="text-[13px] text-[var(--hob-soft)]"
                            onSave={(v) => act({ action: "gift_update", ids, patch: { handle: v } })}
                          />
                        </div>
                      </div>
                      <div className="border-e border-[var(--hob-rule)]">
                        <KindCell
                          value={first.kind}
                          onChange={(v) => act({ action: "gift_update", ids, patch: { kind: v } })}
                        />
                      </div>
                      <div className="flex items-stretch border-e border-[var(--hob-rule)]">
                        {multi ? (
                          <button
                            type="button"
                            onClick={() => toggle(key)}
                            className="flex min-w-0 flex-1 items-center gap-1.5 ps-3 text-start text-[13px] font-medium text-[var(--hob-accent)] hover:bg-[var(--hob-hover)]"
                          >
                            <span
                              className={`inline-block text-[10px] transition-transform ${isOpen ? "" : "-rotate-90"}`}
                            >
                              ▾
                            </span>
                            {rows.length} פריטים
                          </button>
                        ) : (
                          <div className="flex min-w-0 flex-1 items-center ps-3 text-[13px] text-[var(--hob-soft)]">
                            <span className="truncate">{first.item_label}</span>
                          </div>
                        )}
                        <button
                          type="button"
                          onClick={() => setAddingFor((k) => (k === key ? null : key))}
                          title={`הוספת פריט נוסף ל${first.person}`}
                          className="px-1.5 text-sm text-[var(--hob-faint)] hover:text-[var(--hob-accent)]"
                        >
                          ＋
                        </button>
                      </div>
                      <div className="border-e border-[var(--hob-rule)]">
                        {multi ? (
                          <div className="flex h-9 items-center justify-center text-[var(--hob-faint)]">—</div>
                        ) : (
                          <SizePicker
                            value={first.size}
                            onChange={(v) =>
                              act({ action: "gift_update", id: first.id, patch: { size: v } })
                            }
                          />
                        )}
                      </div>
                      <div className="border-e border-[var(--hob-rule)]">
                        {multi ? (
                          <div className="flex h-9 items-center justify-center font-semibold">
                            {totalQty}
                          </div>
                        ) : (
                          <QtyStepper
                            value={first.qty}
                            onChange={(v) =>
                              v >= 1 &&
                              act({ action: "gift_update", id: first.id, patch: { qty: v } })
                            }
                          />
                        )}
                      </div>
                      <div className="border-e border-[var(--hob-rule)]">
                        <PillCell
                          value={first.status}
                          vocab={GIFT_STATUS}
                          order={GIFT_STATUS_ORDER}
                          onChange={(v) =>
                            act({ action: "gift_update", ids, patch: { status: v } })
                          }
                        />
                      </div>
                      <div className="border-e border-[var(--hob-rule)]">
                        <NoteCell
                          value={first.note}
                          placeholder="＋ הערה"
                          className="text-[13px] text-[var(--hob-soft)]"
                          onSave={(v) => act({ action: "gift_update", ids, patch: { note: v } })}
                        />
                      </div>
                      <div className="flex items-center justify-center">
                        <DeleteButton onConfirm={() => act({ action: "gift_del", ids })} />
                      </div>
                    </div>
                    {multi && isOpen && (
                      <div
                        className="bg-[var(--hob-bg2)]"
                        style={{ borderInlineStart: "5px solid #e6e9f2" }}
                      >
                        {rows.map((g) => (
                          <div
                            key={g.id}
                            className="flex items-center gap-2 border-t border-[var(--hob-hover)] py-1 pe-2 ps-8"
                          >
                            <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--hob-ink)]">
                              {g.item_label}
                            </span>
                            <div className="w-20 shrink-0 rounded-md border border-[var(--hob-rule)] bg-[var(--hob-surface)]">
                              <SizePicker
                                value={g.size}
                                onChange={(v) =>
                                  act({ action: "gift_update", id: g.id, patch: { size: v } })
                                }
                              />
                            </div>
                            <div className="shrink-0 rounded-md border border-[var(--hob-rule)] bg-[var(--hob-surface)]">
                              <QtyStepper
                                value={g.qty}
                                onChange={(v) =>
                                  v >= 1 &&
                                  act({ action: "gift_update", id: g.id, patch: { qty: v } })
                                }
                              />
                            </div>
                            <DeleteButton onConfirm={() => act({ action: "gift_del", id: g.id })} />
                          </div>
                        ))}
                      </div>
                    )}
                    {addingFor === key && (
                      <div
                        className="border-t border-[var(--hob-hover)] bg-[var(--hob-bg2)] py-1.5 pe-2 ps-8"
                        style={{ borderInlineStart: "5px solid #e6e9f2" }}
                      >
                        <AddLineInline items={items} onAdd={addLineToPerson(first)} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </section>

      {/* Manual sales (until Shopify is live) */}
      <section className="mb-7">
        <div
          className="mb-1.5 flex items-center gap-2 text-base font-semibold"
          style={{ color: SALE_COLOR }}
        >
          🛒 מכירות
          <button
            type="button"
            onClick={() => setPopupOpen(true)}
            className="rounded-full bg-[#14142b] px-3 py-1 text-[11.5px] font-bold text-white hover:bg-[#2b2b47]"
            title="מסך מכירה מהירה לאירועים — שלוש נגיעות למכירה"
          >
            🎪 מצב פופ-אפ
          </button>
          <span className="text-xs font-normal text-[var(--hob-faint)] dm-block">
            {sales.length > 0
              ? [
                  `${saleGroups.filter((g) => g.rows.some((r) => r.channel !== "archive")).length} מכירות · ${ILS(totals.revenue)}`,
                  ...(() => {
                    const byStatus = (st: string) =>
                      saleGroups.filter((g) => (g.rows[0].ship_status || "recorded") === st)
                        .length;
                    const parts: string[] = [];
                    const rec = byStatus("recorded");
                    const packed = byStatus("packed");
                    const shipped = byStatus("shipped");
                    if (rec) parts.push(`${rec} ממתינות לאריזה`);
                    if (packed) parts.push(`${packed} מוכנות למשלוח`);
                    if (shipped) parts.push(`${shipped} בדרך`);
                    return parts;
                  })(),
                ].join(" · ")
              : "רישום ידני עד שהחנות בשופיפיי תעלה"}
          </span>
        </div>

        <AddSaleForm items={items} onAdd={(s) => act({ action: "sale_add", ...s, note: "" })} />

        {/* Mobile: one card per buyer+date, item lines inside */}
        <div className="space-y-2 sm:hidden">
          {displaySaleGroups.map(({ key, rows, ids }) => {
            if (key === "__archive__") {
              return (
                <ArchiveToggle
                  key={key}
                  variant="card"
                  count={archiveGroups.length}
                  open={archiveOpen}
                  onToggle={toggleArchive}
                />
              );
            }
            const first = rows[0];
            const groupTotal = rows.reduce((sum, r) => sum + r.price * r.qty, 0);
            return (
              <div
                key={key}
                draggable
                onDragStart={dragStart("sale", key)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  dropOn("sale", saleGroups.findIndex((g) => g.key === key));
                }}
                className="group rounded-lg border border-[var(--hob-rule)] bg-[var(--hob-surface)] p-2.5 shadow-sm"
                style={{ borderInlineStart: `5px solid ${SALE_COLOR}` }}
              >
                <div className="flex items-start gap-1">
                  <div className="min-w-0 flex-1">
                    <EditableText
                      value={first.buyer}
                      onSave={(v) =>
                        v && act({ action: "sale_update", ids, patch: { buyer: v } })
                      }
                      className="rounded-md font-medium"
                    />
                  </div>
                  <PopupBadge rows={rows} />
                  <RepeatBadge rows={rows} />
                  <button
                    type="button"
                    onClick={() => toggle(`cust:${key}`)}
                    title="פרטי לקוח"
                    className={`shrink-0 rounded-md px-1.5 py-0.5 text-[13px] transition-opacity hover:bg-[var(--hob-hover)] ${
                      hasContact(first) || expanded[`cust:${key}`] ? "opacity-100" : "opacity-40"
                    }`}
                  >
                    👤
                  </button>
                  <DeleteButton onConfirm={() => act({ action: "sale_del", ids })} />
                </div>
                {expanded[`cust:${key}`] && <CustomerDetails first={first} ids={ids} act={act} rows={rows} />}
                <div className="flex items-center gap-2 px-3 text-[13px] text-[var(--hob-soft)]">
                  <GroupTotalEdit rows={rows} act={act} />
                  <div className="w-32">
                    <PillCell
                      value={first.ship_status || "recorded"}
                      vocab={SHIP_STATUS}
                      order={SHIP_STATUS_ORDER}
                      rounded
                      onChange={(v) =>
                        act({ action: "sale_update", ids, patch: { ship_status: v } })
                      }
                    />
                  </div>
                  <div className="w-28">
                    <PillCell
                      value={first.pay_method || ""}
                      vocab={PAY_METHOD}
                      order={PAY_METHOD_ORDER}
                      rounded
                      onChange={(v) =>
                        act({ action: "sale_update", ids, patch: { pay_method: v } })
                      }
                    />
                  </div>
                </div>
                <div className="mt-1 divide-y divide-[var(--hob-hover)] rounded-md border border-[var(--hob-rule)]">
                  {rows.map((s) => (
                    <div key={s.id} className="flex items-center gap-1.5 ps-2">
                      <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--hob-ink)]">
                        {s.item_label}
                      </span>
                      <div className="w-16 shrink-0">
                        <SizePicker
                          value={s.size}
                          onChange={(v) =>
                            act({ action: "sale_update", id: s.id, patch: { size: v } })
                          }
                        />
                      </div>
                      <div className="shrink-0">
                        <QtyStepper
                          value={s.qty}
                          onChange={(v) =>
                            v >= 1 && act({ action: "sale_update", id: s.id, patch: { qty: v } })
                          }
                        />
                      </div>
                      <div className="w-14 shrink-0">
                        <EditableText
                          value={String(s.price)}
                          className="dm text-center text-[13px]"
                          inputMode="decimal"
                            onSave={(v) => {
                            const p = parseMoney(v);
                            if (Number.isFinite(p) && p >= 0) {
                              act({ action: "sale_update", id: s.id, patch: { price: p } });
                            }
                          }}
                        />
                      </div>
                      {rows.length > 1 && (
                        <DeleteButton onConfirm={() => act({ action: "sale_del", id: s.id })} />
                      )}
                    </div>
                  ))}
                </div>
                <NoteCell
                  value={first.note}
                  placeholder="＋ הערה"
                  className="mt-1 rounded-md text-[13px] text-[var(--hob-soft)]"
                  onSave={(v) => act({ action: "sale_update", ids, patch: { note: v } })}
                />
              </div>
            );
          })}
        </div>

        {/* Desktop: table */}
        {sales.length > 0 && (
          <div className="hidden overflow-x-auto rounded-lg border border-[var(--hob-rule-strong)] shadow-sm sm:block">
            <div className="min-w-[1070px]">
              <div
                className="grid grid-cols-[minmax(150px,1.3fr)_minmax(170px,1.4fr)_70px_64px_110px_100px_116px_112px_minmax(130px,1fr)_44px] border-b border-[var(--hob-rule-strong)] bg-[var(--hob-bg2)] text-center text-[13px] font-medium text-[var(--hob-soft)]"
                style={{ borderInlineStart: "5px solid transparent" }}
              >
                <div className="border-e border-[var(--hob-rule)] py-2 ps-3 text-start">קונה</div>
                <div className="border-e border-[var(--hob-rule)] py-2 ps-3 text-start">פריט</div>
                <div className="border-e border-[var(--hob-rule)] py-2">מידה</div>
                <div className="border-e border-[var(--hob-rule)] py-2">כמות</div>
                <div className="border-e border-[var(--hob-rule)] py-2">₪ ליחידה</div>
                <div className="border-e border-[var(--hob-rule)] py-2">סה״כ</div>
                <div className="border-e border-[var(--hob-rule)] py-2">משלוח</div>
                <div className="border-e border-[var(--hob-rule)] py-2">תשלום</div>
                <div className="border-e border-[var(--hob-rule)] py-2 ps-3 text-start">הערות</div>
                <div />
              </div>
              {displaySaleGroups.map(({ key, rows, ids }) => {
                if (key === "__archive__") {
                  return (
                    <ArchiveToggle
                      key={key}
                      variant="row"
                      count={archiveGroups.length}
                      open={archiveOpen}
                      onToggle={toggleArchive}
                    />
                  );
                }
                const first = rows[0];
                const multi = rows.length > 1;
                const isOpen = Boolean(expanded[key]);
                const totalQty = rows.reduce((sum, r) => sum + r.qty, 0);
                const groupTotal = rows.reduce((sum, r) => sum + r.price * r.qty, 0);
                return (
                  <div
                    key={key}
                    draggable
                    onDragStart={dragStart("sale", key)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      dropOn("sale", saleGroups.findIndex((g) => g.key === key));
                    }}
                    className="border-b border-[var(--hob-rule)] last:border-b-0"
                  >
                    <div
                      className="group grid grid-cols-[minmax(150px,1.3fr)_minmax(170px,1.4fr)_70px_64px_110px_100px_116px_112px_minmax(130px,1fr)_44px] items-stretch bg-[var(--hob-surface)] text-sm text-[var(--hob-ink)]"
                      style={{ borderInlineStart: `5px solid ${SALE_COLOR}` }}
                    >
                      <div className="border-e border-[var(--hob-rule)]">
                        <div className="flex items-center">
                          <div className="min-w-0 flex-1">
                            <EditableText
                              value={first.buyer}
                              onSave={(v) =>
                                v && act({ action: "sale_update", ids, patch: { buyer: v } })
                              }
                            />
                          </div>
                          <PopupBadge rows={rows} />
                          <RepeatBadge rows={rows} />
                          <button
                            type="button"
                            onClick={() => toggle(`cust:${key}`)}
                            title="פרטי לקוח"
                            className={`shrink-0 rounded-md px-1 text-[13px] transition-opacity hover:bg-[var(--hob-hover)] ${
                              hasContact(first) || expanded[`cust:${key}`]
                                ? "opacity-100"
                                : "opacity-0 group-hover:opacity-40"
                            }`}
                          >
                            👤
                          </button>
                        </div>
                      </div>
                      {multi ? (
                        <button
                          type="button"
                          onClick={() => toggle(key)}
                          className="flex items-center gap-1.5 border-e border-[var(--hob-rule)] px-3 text-start text-[13px] font-medium text-[var(--hob-good)] hover:bg-[#00c875]/15"
                        >
                          <span
                            className={`inline-block text-[10px] transition-transform ${isOpen ? "" : "-rotate-90"}`}
                          >
                            ▾
                          </span>
                          {rows.length} פריטים
                        </button>
                      ) : (
                        <div className="flex items-center border-e border-[var(--hob-rule)] px-3 text-[13px] text-[var(--hob-soft)]">
                          <span className="truncate">{first.item_label}</span>
                        </div>
                      )}
                      <div className="border-e border-[var(--hob-rule)]">
                        {multi ? (
                          <div className="flex h-9 items-center justify-center text-[var(--hob-faint)]">—</div>
                        ) : (
                          <SizePicker
                            value={first.size}
                            onChange={(v) =>
                              act({ action: "sale_update", id: first.id, patch: { size: v } })
                            }
                          />
                        )}
                      </div>
                      <div className="border-e border-[var(--hob-rule)]">
                        {multi ? (
                          <div className="flex h-9 items-center justify-center font-semibold">
                            {totalQty}
                          </div>
                        ) : (
                          <QtyStepper
                            value={first.qty}
                            onChange={(v) =>
                              v >= 1 &&
                              act({ action: "sale_update", id: first.id, patch: { qty: v } })
                            }
                          />
                        )}
                      </div>
                      <div className="border-e border-[var(--hob-rule)]">
                        {multi ? (
                          <div className="flex h-9 items-center justify-center text-[var(--hob-faint)]">—</div>
                        ) : (
                          <EditableText
                            value={String(first.price)}
                            className="text-center"
                            inputMode="decimal"
                              onSave={(v) => {
                              const p = parseMoney(v);
                              if (Number.isFinite(p) && p >= 0) {
                                act({ action: "sale_update", id: first.id, patch: { price: p } });
                              }
                            }}
                          />
                        )}
                      </div>
                      <div className="flex items-center justify-center border-e border-[var(--hob-rule)]">
                        <GroupTotalEdit rows={rows} act={act} />
                      </div>
                      <div className="border-e border-[var(--hob-rule)]">
                        <PillCell
                          value={first.ship_status || "recorded"}
                          vocab={SHIP_STATUS}
                          order={SHIP_STATUS_ORDER}
                          onChange={(v) =>
                            act({ action: "sale_update", ids, patch: { ship_status: v } })
                          }
                        />
                      </div>
                      <div className="border-e border-[var(--hob-rule)]">
                        <PillCell
                          value={first.pay_method || ""}
                          vocab={PAY_METHOD}
                          order={PAY_METHOD_ORDER}
                          onChange={(v) =>
                            act({ action: "sale_update", ids, patch: { pay_method: v } })
                          }
                        />
                      </div>
                      <div className="border-e border-[var(--hob-rule)]">
                        <NoteCell
                          value={first.note}
                          placeholder="＋ הערה"
                          className="text-[13px] text-[var(--hob-soft)]"
                          onSave={(v) => act({ action: "sale_update", ids, patch: { note: v } })}
                        />
                      </div>
                      <div className="flex items-center justify-center">
                        <DeleteButton onConfirm={() => act({ action: "sale_del", ids })} />
                      </div>
                    </div>
                    {expanded[`cust:${key}`] && (
                      <CustomerDetails first={first} ids={ids} act={act} wide rows={rows} />
                    )}
                    {multi && isOpen && (
                      <div
                        className="bg-[var(--hob-bg2)]"
                        style={{ borderInlineStart: "5px solid #e6e9f2" }}
                      >
                        {rows.map((s) => (
                          <div
                            key={s.id}
                            className="flex items-center gap-2 border-t border-[var(--hob-hover)] py-1 pe-2 ps-8"
                          >
                            <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--hob-ink)]">
                              {s.item_label}
                            </span>
                            <div className="w-20 shrink-0 rounded-md border border-[var(--hob-rule)] bg-[var(--hob-surface)]">
                              <SizePicker
                                value={s.size}
                                onChange={(v) =>
                                  act({ action: "sale_update", id: s.id, patch: { size: v } })
                                }
                              />
                            </div>
                            <div className="shrink-0 rounded-md border border-[var(--hob-rule)] bg-[var(--hob-surface)]">
                              <QtyStepper
                                value={s.qty}
                                onChange={(v) =>
                                  v >= 1 &&
                                  act({ action: "sale_update", id: s.id, patch: { qty: v } })
                                }
                              />
                            </div>
                            <div className="w-16 shrink-0 rounded-md border border-[var(--hob-rule)] bg-[var(--hob-surface)]">
                              <EditableText
                                value={String(s.price)}
                                className="dm text-center text-[13px]"
                                inputMode="decimal"
                                  onSave={(v) => {
                                  const p = parseMoney(v);
                                  if (Number.isFinite(p) && p >= 0) {
                                    act({ action: "sale_update", id: s.id, patch: { price: p } });
                                  }
                                }}
                              />
                            </div>
                            <DeleteButton onConfirm={() => act({ action: "sale_del", id: s.id })} />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

