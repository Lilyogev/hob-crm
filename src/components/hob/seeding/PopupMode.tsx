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
import { BUCKETS, ILS, LOCATIONS, SeedItem, SeedSale, Shs, itemLabel, stockAt } from "./shared";

export const POPUP_BUYER = "פופ-אפ";
// Bucket column → the size string a sale line records ("" = no size).
const BUCKET_SIZE: Record<string, string> = {
  qty: "", qty_xs: "XS", qty_s: "S", qty_m: "M", qty_l: "L", qty_xl: "XL", qty_xxl: "XXL",
};
// Payment options offered at the stand. Hyp is the card terminal, so it
// leads; the short labels keep the confirm button readable.
const POPUP_PAY: [string, string][] = [
  ["hyp", "💳 Hyp"],
  ["bit", "📱 ביט"],
  ["cash", "💵 מזומן"],
];
const POPUP_PAY_SHORT: Record<string, string> = { hyp: "Hyp", bit: "ביט", cash: "מזומן" };

// The last nav-button popup signal already acted on (see the effect in
// SeedingView). Module scope on purpose — it must survive tab switches.

export function PopupMode({
  items,
  sales,
  act,
  pending,
  onClose,
}: {
  items: SeedItem[];
  sales: SeedSale[];
  act: (body: Record<string, unknown>) => void;
  pending: boolean;
  onClose: () => void;
}) {
  const [loc, setLoc] = useState<string>(() => {
    try { return localStorage.getItem("hob_popup_loc") || "car"; } catch { return "car"; }
  });
  const [pay, setPay] = useState<string>(() => {
    try { return localStorage.getItem("hob_popup_pay") || "hyp"; } catch { return "hyp"; }
  });
  const [selItemId, setSelItemId] = useState<number | null>(null);
  // null = not picked yet; "" = explicitly "no size". A real pick is required
  // so a rushed double-tap can't record the wrong bucket.
  const [selSize, setSelSize] = useState<string | null>(null);
  // Optional customer details — the data the partners keep for future drops.
  // Left empty, the sale records under the anonymous pop-up sentinel.
  const [buyerName, setBuyerName] = useState("");
  const [buyerPhone, setBuyerPhone] = useState("");
  // The last suggestion the seller tapped — while the name equals it, the
  // suggestion list stays closed instead of re-opening over the keyboard.
  const [pickedBuyer, setPickedBuyer] = useState("");
  const [flash, setFlash] = useState("");
  // 💰 the till view — today's pop-up sales + cash-box math.
  const [showTill, setShowTill] = useState(false);
  const [editSaleId, setEditSaleId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editPhone, setEditPhone] = useState("");
  const [editPrice, setEditPrice] = useState("");
  // Price override for the current sale — empty means the list price. This is
  // how a stand discount gets recorded at the amount actually paid.
  const [priceStr, setPriceStr] = useState("");

  const pickLoc = (k: string) => {
    setLoc(k);
    try { localStorage.setItem("hob_popup_loc", k); } catch { /* ignore */ }
  };
  const pickPay = (k: string) => {
    setPay(k);
    try { localStorage.setItem("hob_popup_pay", k); } catch { /* ignore */ }
  };

  const today = todayISO();
  const todayRows = sales.filter((s) => s.channel === "popup" && s.sold_at === today);
  const dayRevenue = todayRows.reduce((s, r) => s + r.price * r.qty, 0);
  const dayCount = todayRows.reduce((s, r) => s + r.qty, 0);
  const lastRow = todayRows.reduce<SeedSale | null>((a, r) => (a && a.id > r.id ? a : r), null);
  // Cash-box math: revenue per payment method, so counting the box at close
  // has a number to match against.
  const dayByPay = todayRows.reduce<Record<string, number>>((acc, r) => {
    const k = r.pay_method || "hyp";
    acc[k] = (acc[k] ?? 0) + r.price * r.qty;
    return acc;
  }, {});

  // Every named buyer the ledger knows (current + archive), for the
  // who-bought autocomplete. Phone = the latest non-empty one on record.
  const knownBuyers = useMemo(() => {
    const map = new Map<string, { name: string; phone: string; dates: Set<string> }>();
    for (const s of sales) {
      const n = (s.buyer || "").trim();
      if (!n || n === POPUP_BUYER) continue;
      const cur = map.get(n) ?? { name: n, phone: "", dates: new Set<string>() };
      if (!cur.phone && s.buyer_phone) cur.phone = s.buyer_phone;
      if (s.sold_at) cur.dates.add(s.sold_at);
      map.set(n, cur);
    }
    return [...map.values()];
  }, [sales]);
  const buyerQuery = buyerName.trim();
  const buyerSuggestions =
    buyerQuery.length >= 2 && buyerQuery !== pickedBuyer
      ? knownBuyers
          .filter((b) => b.name.includes(buyerQuery) || (b.phone && b.phone.includes(buyerQuery)))
          .slice(0, 4)
      : [];

  const item = items.find((i) => i.id === selItemId) ?? null;
  const stockAt = (i: SeedItem) => i.stock.find((r) => r.location === loc);
  const totalAt = (i: SeedItem) => {
    const r = stockAt(i);
    return r ? r.qty + r.qty_xs + r.qty_s + r.qty_m + r.qty_l + r.qty_xl + r.qty_xxl : 0;
  };

  const parsedPrice = parseFloat(priceStr.replace(/[^\d.]/g, ""));
  const priceOverridden = priceStr.trim() !== "" && isFinite(parsedPrice) && parsedPrice > 0;
  const effPrice = priceOverridden ? Math.round(parsedPrice) : (item?.price ?? 0);

  const canSell = !!item && selSize !== null && effPrice > 0 && !pending;
  const sell = () => {
    if (!item || selSize === null || !canSell) return;
    const name = buyerName.trim();
    act({
      action: "sale_add",
      buyer: name || POPUP_BUYER,
      buyerPhone: buyerPhone.trim(),
      channel: "popup",
      items: [{ itemId: item.id, qty: 1, size: selSize, price: effPrice }],
      location: loc,
      payMethod: pay,
      note: "",
      // Without an explicit date the row lands with sold_at='' and the till
      // (which filters by today) never shows it — caught live on 20.8.
      soldAt: today,
    });
    setFlash(
      `${item.name}${selSize ? ` ${selSize}` : ""}${name ? ` · ${name}` : ""} · ${POPUP_PAY_SHORT[pay] ?? pay} · ${ILS(effPrice)}${priceOverridden && item.price > 0 && effPrice !== item.price ? ` (מחירון ${ILS(item.price)})` : ""}`,
    );
    setSelSize(null); // the next customer picks their own size
    setBuyerName("");
    setBuyerPhone("");
    setPickedBuyer("");
    setPriceStr(""); // the discount was personal — back to list price
  };
  const editPriceVal = parseFloat(editPrice.replace(/[^\d.]/g, ""));
  const editPriceOk = editPrice.trim() !== "" && isFinite(editPriceVal) && editPriceVal > 0;
  const saveBuyerEdit = () => {
    if (editSaleId === null || pending) return;
    const name = editName.trim();
    const patch: Record<string, unknown> = {};
    if (name) {
      patch.buyer = name;
      patch.buyer_phone = editPhone.trim();
    }
    if (editPriceOk) patch.price = Math.round(editPriceVal);
    if (!Object.keys(patch).length) return;
    act({ action: "sale_update", id: editSaleId, patch });
    setEditSaleId(null);
  };
  const undo = () => {
    if (!lastRow || pending) return;
    act({ action: "sale_del", id: lastRow.id });
    setFlash("↩ המכירה האחרונה בוטלה — המלאי חזר");
  };

  return (
    <div className="fixed inset-0 z-[60] overflow-y-auto bg-[var(--hob-bg2)]" dir="rtl">
      {/* Session header */}
      <div className="sticky top-0 z-10 bg-[#14142b] px-4 py-3 text-white">
        <div className="flex items-baseline justify-between">
          <span className="text-[15px] font-extrabold">🎪 מצב פופ-אפ</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setShowTill((v) => !v)}
              className={`rounded-md px-2 py-1 text-xs ${showTill ? "bg-white font-bold text-[#14142b]" : "opacity-80 hover:bg-white/10"}`}
            >
              💰 קופה
            </button>
            <button type="button" onClick={onClose} className="rounded-md px-2 py-1 text-xs opacity-80 hover:bg-white/10">
              ✕ יציאה
            </button>
          </div>
        </div>
        <div className="mt-2 flex items-end gap-5">
          <div>
            <div className="text-[22px] font-extrabold leading-none">{Shs(dayRevenue)}</div>
            <div className="mt-0.5 text-[10.5px] opacity-70">פדיון היום</div>
          </div>
          <div>
            <div className="text-[22px] font-extrabold leading-none dm">{dayCount}</div>
            <div className="mt-0.5 text-[10.5px] opacity-70">מכירות</div>
          </div>
          <div className="mr-auto flex gap-1">
            {LOCATIONS.map((l) => (
              <button
                key={l.key}
                type="button"
                onClick={() => pickLoc(l.key)}
                className={`rounded-full px-2.5 py-1 text-[11px] ${
                  loc === l.key ? "bg-white font-bold text-[#14142b]" : "bg-white/15"
                }`}
                title={`המלאי יירד מ: ${l.label}`}
              >
                {l.icon} {l.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {showTill && (
        <div className="mx-auto max-w-md px-4 pb-16 pt-3">
          {/* Totals — the number to match when counting the cash box */}
          <div className="rounded-xl bg-[var(--hob-surface)] p-3 shadow-sm">
            <div className="flex items-baseline justify-between">
              <b className="text-[14px] text-[var(--hob-ink)]">היום · {dayCount} מכירות</b>
              <b className="text-[16px] text-[var(--hob-good)]">{Shs(dayRevenue)}</b>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {POPUP_PAY.map(([k]) =>
                dayByPay[k] ? (
                  <span key={k} className="rounded-full bg-[var(--hob-hover)] px-2.5 py-1 text-[12px] font-bold text-[var(--hob-ink)]">
                    {POPUP_PAY_SHORT[k] ?? k} · {Shs(dayByPay[k])}
                  </span>
                ) : null,
              )}
            </div>
            {(dayByPay.cash ?? 0) > 0 && (
              <div className="mt-2 rounded-lg bg-[#fdab3d]/20 px-2.5 py-1.5 text-[12px] font-bold text-[var(--hob-ink)]">
                💵 בקופסת המזומן אמורים להיות {Shs(dayByPay.cash)}
              </div>
            )}
          </div>

          {/* Sale lines, newest first; anonymous ones take a name after the rush */}
          <div className="mt-3 space-y-1.5">
            {todayRows.length === 0 && (
              <div className="rounded-xl bg-[var(--hob-surface)] p-4 text-center text-[13px] text-[var(--hob-faint)]">
                עוד אין מכירות היום — הקופה תתמלא מכאן
              </div>
            )}
            {[...todayRows]
              .sort((a, b) => b.id - a.id)
              .map((r) => {
                const anon = !r.buyer || r.buyer === POPUP_BUYER;
                const editing = editSaleId === r.id;
                return (
                  <div key={r.id} className="rounded-xl bg-[var(--hob-surface)] p-2.5 shadow-sm">
                    <div className="flex items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-bold text-[var(--hob-ink)]">
                          {anon ? <span className="font-normal text-[var(--hob-faint)]">אנונימי</span> : r.buyer}
                          {!anon && r.buyer_phone && (
                            <span className="dm mr-1.5 text-[11px] font-normal text-[var(--hob-faint)]" dir="ltr">
                              {r.buyer_phone}
                            </span>
                          )}
                        </div>
                        <div className="truncate text-[11.5px] text-[var(--hob-soft)]">
                          {r.item_label}
                          {r.size ? ` · ${r.size}` : ""}
                        </div>
                      </div>
                      <span className="rounded-full bg-[var(--hob-hover)] px-2 py-0.5 text-[11px] font-bold">
                        {POPUP_PAY_SHORT[r.pay_method] ?? r.pay_method}
                      </span>
                      <b className="text-[13px]">{Shs(r.price * r.qty)}</b>
                      {!editing && (
                        <button
                          type="button"
                          className="shrink-0 text-[11.5px] font-bold text-[var(--hob-accent)]"
                          onClick={() => {
                            setEditSaleId(r.id);
                            setEditName(anon ? "" : r.buyer);
                            setEditPhone(r.buyer_phone || "");
                            setEditPrice(String(r.price));
                          }}
                        >
                          {anon ? "＋ שם" : "עריכה"}
                        </button>
                      )}
                    </div>
                    {editing && (
                      <div className="mt-2 flex gap-1.5">
                        <input
                          autoFocus
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          placeholder="שם"
                          className="h-10 min-w-0 flex-1 rounded-lg border border-[var(--hob-rule)] px-2.5 text-[13px] outline-none focus:border-[var(--hob-accent)]"
                        />
                        <input
                          value={editPhone}
                          onChange={(e) => setEditPhone(e.target.value)}
                          placeholder="טלפון"
                          type="tel"
                          inputMode="tel"
                          dir="ltr"
                          className="dm h-10 w-24 rounded-lg border border-[var(--hob-rule)] px-2.5 text-left text-[13px] outline-none focus:border-[var(--hob-accent)]"
                        />
                        <input
                          value={editPrice}
                          onChange={(e) => setEditPrice(e.target.value)}
                          placeholder="₪"
                          inputMode="numeric"
                          dir="ltr"
                          title="מחיר — לעדכון אחרי הנחה"
                          className={`dm h-10 w-16 rounded-lg border px-2 text-center text-[13px] font-bold outline-none focus:border-[var(--hob-accent)] ${
                            editPriceOk && Math.round(editPriceVal) !== r.price ? "border-[#b45309]" : "border-[var(--hob-rule)]"
                          }`}
                        />
                        <button
                          type="button"
                          onClick={saveBuyerEdit}
                          disabled={pending || (!editName.trim() && !editPriceOk)}
                          className="rounded-lg bg-[var(--hob-good)] px-3 text-[13px] font-bold text-white disabled:bg-[var(--hob-faint)]"
                        >
                          ✓
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditSaleId(null)}
                          className="rounded-lg border border-[var(--hob-rule)] px-2.5 text-[13px]"
                        >
                          ✕
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        </div>
      )}

      {!showTill && (
      <div className="mx-auto max-w-md px-4 pb-28 pt-3">
        {/* 1 · product */}
        <div className="mb-1 text-[11px] font-bold text-[var(--hob-faint)]">1 · מה נמכר?</div>
        <div className="grid grid-cols-2 gap-2">
          {items.map((i) => {
            const left = totalAt(i);
            const sel = i.id === selItemId;
            return (
              <button
                key={i.id}
                type="button"
                onClick={() => { setSelItemId(i.id); setSelSize(null); setPriceStr(""); }}
                className={`rounded-2xl border p-3 text-center transition-colors ${
                  sel ? "border-2 border-[var(--hob-accent)] bg-[#0073ea]/20" : "border-[var(--hob-rule)] bg-[var(--hob-surface)]"
                }`}
              >
                <div className="text-[14px] font-extrabold text-[var(--hob-ink)]">{itemLabel(i)}</div>
                <div className="mt-0.5 text-[11px] text-[var(--hob-soft)]">
                  {i.price > 0 ? <>{Shs(i.price)}</> : "אין מחיר"}
                  {left > 0 && <span className="dm"> · נשארו {left}</span>}
                </div>
              </button>
            );
          })}
        </div>

        {/* 2 · size */}
        {item && (
          <>
            <div className="mb-1 mt-4 text-[11px] font-bold text-[var(--hob-faint)]">2 · מידה</div>
            <div className="flex gap-1.5">
              {BUCKETS.map((b) => {
                const size = BUCKET_SIZE[b.col];
                const row = stockAt(item);
                const count = row ? row[b.col] : 0;
                const sel = selSize === size;
                return (
                  <button
                    key={b.col}
                    type="button"
                    onClick={() => setSelSize(size)}
                    className={`flex-1 rounded-xl border py-2.5 text-center transition-colors ${
                      sel ? "border-2 border-[var(--hob-good)] bg-[#00c875]/20 font-extrabold" : "border-[var(--hob-rule)] bg-[var(--hob-surface)] font-bold"
                    }`}
                  >
                    <div className="text-[13px]">{size || "—"}</div>
                    <div className="dm text-[9.5px] font-normal text-[var(--hob-faint)]">{count}</div>
                  </button>
                );
              })}
            </div>

            {/* 3 · payment */}
            <div className="mb-1 mt-4 text-[11px] font-bold text-[var(--hob-faint)]">3 · תשלום</div>
            <div className="flex items-stretch gap-2">
              {POPUP_PAY.map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => pickPay(k)}
                  className={`flex-1 rounded-xl border py-2.5 text-center font-bold transition-colors ${
                    pay === k ? "border-2 border-[var(--hob-accent)] bg-[#0073ea]/20 font-extrabold" : "border-[var(--hob-rule)] bg-[var(--hob-surface)]"
                  }`}
                >
                  {label}
                </button>
              ))}
              <div
                className={`flex w-24 items-center rounded-xl border bg-[var(--hob-surface)] ${
                  priceOverridden && item.price > 0 && effPrice !== item.price
                    ? "border-2 border-[#b45309]"
                    : "border-[var(--hob-rule)]"
                }`}
              >
                <span className="ps-2 text-[13px] font-bold text-[var(--hob-faint)]">₪</span>
                <input
                  value={priceStr}
                  onChange={(e) => setPriceStr(e.target.value)}
                  placeholder={item.price > 0 ? String(item.price) : "מחיר"}
                  inputMode="numeric"
                  dir="ltr"
                  className="dm w-full min-w-0 rounded-xl bg-transparent px-1.5 py-2.5 text-center text-[15px] font-extrabold outline-none placeholder:font-extrabold placeholder:text-[var(--hob-ink)]"
                />
              </div>
            </div>
            {priceOverridden && item.price > 0 && effPrice !== item.price && (
              <p className="dm-block mt-1.5 text-[11.5px] font-bold text-[#b45309]">
                🏷 הנחה: {ILS(effPrice)} במקום {ILS(item.price)} — יירשם הסכום ששולם בפועל
              </p>
            )}
            {!(effPrice > 0) && (
              <p className="mt-1.5 text-[11.5px] text-[#e2445c]">
                לפריט הזה אין מחיר — הקלידו סכום בתיבת המחיר, או קבעו מחיר קבוע בעמודת ₪ מחיר בטאב חלוקות.
              </p>
            )}

            {/* 4 · customer — optional, this is the data for the next drop */}
            <div className="mb-1 mt-4 text-[11px] font-bold text-[var(--hob-faint)]">
              4 · מי הקונה? <span className="font-normal">(לא חובה — דאטה לדרופ הבא)</span>
            </div>
            <div className="flex gap-2">
              <input
                value={buyerName}
                onChange={(e) => setBuyerName(e.target.value)}
                placeholder="שם"
                className="h-11 min-w-0 flex-1 rounded-xl border border-[var(--hob-rule)] bg-[var(--hob-surface)] px-3 text-[14px] outline-none placeholder:text-[var(--hob-faint)] focus:border-[var(--hob-accent)]"
              />
              <input
                value={buyerPhone}
                onChange={(e) => setBuyerPhone(e.target.value)}
                placeholder="טלפון"
                type="tel"
                inputMode="tel"
                dir="ltr"
                className="dm h-11 w-32 rounded-xl border border-[var(--hob-rule)] bg-[var(--hob-surface)] px-3 text-left text-[14px] outline-none placeholder:text-[var(--hob-faint)] focus:border-[var(--hob-accent)]"
              />
            </div>
            {/* Known-buyer suggestions — one tap links the sale to an existing
                customer and surfaces that they bought before. */}
            {buyerSuggestions.length > 0 && (
              <div className="mt-1.5 overflow-hidden rounded-xl border border-[var(--hob-rule)] bg-[var(--hob-surface)]">
                {buyerSuggestions.map((b) => (
                  <button
                    key={b.name}
                    type="button"
                    onClick={() => {
                      setBuyerName(b.name);
                      if (b.phone) setBuyerPhone(b.phone);
                      setPickedBuyer(b.name);
                    }}
                    className="flex w-full items-center justify-between border-b border-[var(--hob-rule)] px-3 py-2.5 text-right last:border-b-0 active:bg-[#0073ea]/20"
                  >
                    <span className="min-w-0 truncate text-[13.5px] font-bold text-[var(--hob-ink)]">
                      {b.name}
                      {b.phone && (
                        <span className="dm mr-2 text-[11px] font-normal text-[var(--hob-faint)]" dir="ltr">
                          {b.phone}
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 rounded-full bg-[#00c875]/15 px-2 py-0.5 text-[10.5px] font-bold text-[var(--hob-good)]">
                      {b.dates.size > 1 ? `חוזר ×${b.dates.size}` : "קנה בעבר"}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
      )}

      {/* Confirm bar — pinned so the thumb never travels */}
      {!showTill && (
      <div className="fixed inset-x-0 bottom-0 z-10 border-t border-[var(--hob-rule)] bg-[var(--hob-surface)]/95 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-2 backdrop-blur">
        <div className="mx-auto max-w-md">
          <button
            type="button"
            onClick={sell}
            disabled={!canSell}
            className="w-full rounded-2xl bg-[var(--hob-good)] py-3.5 text-center text-[16px] font-extrabold text-white disabled:bg-[var(--hob-faint)]"
          >
            {item && selSize !== null
              ? `✓ נמכר! — ${item.name}${selSize ? ` ${selSize}` : ""} · ${POPUP_PAY_SHORT[pay] ?? pay}`
              : "בחרו מוצר ומידה"}
          </button>
          <div className="mt-1.5 flex items-center justify-between text-[11.5px]">
            <span className="dm-block truncate text-[var(--hob-faint)]">{flash || (lastRow ? `אחרונה: ${lastRow.item_label} · ${ILS(lastRow.price)}` : "")}</span>
            {lastRow && (
              <button type="button" onClick={undo} className="shrink-0 font-bold text-[#e2445c]">
                ↩ בטל אחרונה
              </button>
            )}
          </div>
        </div>
      </div>
      )}
    </div>
  );
}

