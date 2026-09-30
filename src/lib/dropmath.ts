// The drop P&L model as a pure module with no React and no DOM, so the
// finance tab's simulator and any server-side reader run the exact same
// numbers.

export type SimProduct = { name: string; qty: number; price: number; cost: number; sellPct: number };
export type DropSim = {
  dropName: string;
  products: SimProduct[];
  itemsPerOrder: number;
  shipPerOrder: number;
  marketing: number;
  fixed: number;
  // עוסק פטור does not charge VAT: the whole price is revenue. false
  // (= עוסק מורשה) restores the ÷1.18. Missing on old saved states → exempt.
  vatExempt?: boolean;
  // Legacy free-form list (older saved states), folded into fixedCosts on load.
  fixedItems?: { name: string; amount: number }[];
  // The structured drop-cost sheet: fixed set of lines, play with numbers only.
  fixedCosts?: Record<string, number>;
  // Why this scenario exists, shown under its row in the saved table.
  note?: string;
  // Optional: how much cash the drop should bring back (the partners' own
  // target). 0 / missing = no target, no progress bar.
  returnTarget?: number;
};

// The fixed-cost lines of a drop. The structure is fixed on purpose: the
// partners edit amounts, not the list. Anything with an unknown name lands
// in "אחר".
export const FIXED_KEYS: string[] = [
  "שיווק ממומן",
  "צילומים והפקה",
  "דוגמאות",
  "אריזה ומיתוג",
  "עיצוב",
  "שיתופי פעולה",
  "אירועים ופופ-אפ",
  "אתר ותוכנות",
  "אחר",
];
const OTHER_KEY = "אחר";
export const MARKETING_KEY = "שיווק ממומן";

// Normalize any older saved shape (marketing slider / free list / lump / a
// line that no longer exists) into the structured cost sheet.
export function normalizeCosts(sim: DropSim): Record<string, number> {
  const base: Record<string, number> = {};
  for (const k of FIXED_KEYS) base[k] = 0;
  if (sim.fixedCosts) {
    for (const [k, v] of Object.entries(sim.fixedCosts)) {
      const n = typeof v === "number" && isFinite(v) ? v : 0;
      base[FIXED_KEYS.includes(k) ? k : OTHER_KEY] += n;
    }
  } else {
    base[MARKETING_KEY] = sim.marketing || 0;
    const legacy = sim.fixedItems ?? (sim.fixed > 0 ? [{ name: OTHER_KEY, amount: sim.fixed }] : []);
    for (const f of legacy) {
      const key = FIXED_KEYS.includes(f.name) ? f.name : OTHER_KEY;
      base[key] += isFinite(f.amount) ? f.amount : 0;
    }
  }
  return base;
}

/** An empty scenario: placeholders only, never a real drop's numbers. */
export function emptySim(opts: { vatExempt: boolean; name?: string } = { vatExempt: true }): DropSim {
  const fixedCosts: Record<string, number> = {};
  for (const k of FIXED_KEYS) fixedCosts[k] = 0;
  return {
    dropName: opts.name ?? "דרופ חדש",
    products: [{ name: "מוצר 1", qty: 100, price: 100, cost: 30, sellPct: 0.7 }],
    itemsPerOrder: 1.2,
    shipPerOrder: 30,
    marketing: 0,
    fixed: 0,
    vatExempt: opts.vatExempt,
    fixedCosts,
    returnTarget: 0,
  };
}

// All the scenario math in one pure function, so the "what if" levers can
// re-run the whole model on a modified drop instead of re-deriving formulas.
export function computeSim(sim: DropSim) {
  const costs = normalizeCosts(sim);
  const vatDiv = sim.vatExempt === false ? 1.18 : 1;
  const fixedSum = FIXED_KEYS.reduce((s, k) => s + costs[k], 0);
  const marketingCost = costs[MARKETING_KEY];
  const otherFixed = fixedSum - marketingCost;

  const perProduct = sim.products.map((p) => {
    const units = Math.round(p.qty * p.sellPct);
    const leftUnits = p.qty - units;
    return {
      ...p,
      units,
      gross: units * p.price,
      unitMargin: p.price / vatDiv - p.cost,
      contribution: units * (p.price / vatDiv - p.cost),
      productionAll: p.qty * p.cost, // the whole run, paid up front
      leftUnits,
      leftValue: leftUnits * p.cost,
    };
  });

  const gross = perProduct.reduce((s, p) => s + p.gross, 0);
  const net = gross / vatDiv;
  const production = perProduct.reduce((s, p) => s + p.units * p.cost, 0);
  const totalUnits = perProduct.reduce((s, p) => s + p.units, 0);
  const orders = sim.itemsPerOrder > 0 ? totalUnits / sim.itemsPerOrder : totalUnits;
  const shipping = orders * sim.shipPerOrder;
  const fees = 0; // card fees are tracked outside the model, by request

  // Classic P&L ladder:
  const grossProfit = net - production;
  const cogsAfterShipping = production + shipping;
  const contribution = net - production - shipping - fees;
  const profit = contribution - fixedSum;

  // What the drop COSTS: the money that has to be on the table.
  const productionAll = perProduct.reduce((s, p) => s + p.productionAll, 0);
  const qtyAll = sim.products.reduce((s, p) => s + p.qty, 0);
  const leftValue = productionAll - production;
  const leftUnits = perProduct.reduce((s, p) => s + p.leftUnits, 0);
  const upfront = productionAll + fixedSum; // needed before a single sale
  const variable = shipping + fees; // paid out of revenue as orders ship
  const landed = upfront + variable;
  const costPerUnitSold = totalUnits > 0 ? landed / totalUnits : 0;
  const upfrontPerUnitMade = qtyAll > 0 ? upfront / qtyAll : 0;
  // The same cost in three layers: factory only, plus the drop's overhead,
  // then everything.
  const unitCostRaw = totalUnits > 0 ? production / totalUnits : 0;
  const unitCostAfterOverhead = totalUnits > 0 ? (production + fixedSum) / totalUnits : 0;
  // Net (not gross): under עוסק מורשה the VAT collected is never theirs to keep.
  const cashProfit = net - landed; // === profit - leftValue

  // Break-even at the current mix; per-unit contribution nets out COGS, card
  // fees, and the unit's share of an order's shipping.
  const shipPerUnit = sim.itemsPerOrder > 0 ? sim.shipPerOrder / sim.itemsPerOrder : sim.shipPerOrder;
  const avgContrib =
    totalUnits > 0
      ? perProduct.reduce((s, p) => s + (p.price / vatDiv - p.cost - shipPerUnit) * p.units, 0) / totalUnits
      : 0;
  const avgPrice = totalUnits > 0 ? gross / totalUnits : 0;
  const breakEvenUnits = avgContrib > 0 ? Math.ceil(fixedSum / avgContrib) : null;

  // Per-product fully-loaded cost: the product's own full production run, its
  // own shipping and card fees, plus an equal-per-unit share of the drop's
  // fixed costs. By construction these sum back to Total Landed Cost.
  const perProductLoaded = perProduct.map((p) => {
    const fixedShare = totalUnits > 0 ? fixedSum * (p.units / totalUnits) : 0;
    const own = p.productionAll + p.units * shipPerUnit + fixedShare;
    return { ...p, fullCostPerUnit: p.units > 0 ? own / p.units : 0 };
  });

  // The optional return target: how far Cash Left is from it (null = no target).
  const returnTarget = typeof sim.returnTarget === "number" && isFinite(sim.returnTarget) && sim.returnTarget > 0 ? sim.returnTarget : null;
  const returnProgress = returnTarget ? Math.max(0, Math.min(1, cashProfit / returnTarget)) : null;

  return {
    costs, vatDiv, fixedSum, marketingCost, otherFixed, perProduct: perProductLoaded, gross, net, production,
    totalUnits, orders, shipping, fees, grossProfit, cogsAfterShipping, contribution, profit,
    productionAll, qtyAll, leftValue, leftUnits, upfront, variable, landed, costPerUnitSold,
    upfrontPerUnitMade, cashProfit, shipPerUnit, avgContrib, avgPrice, breakEvenUnits,
    unitCostRaw, unitCostAfterOverhead, returnTarget, returnProgress,
  };
}
