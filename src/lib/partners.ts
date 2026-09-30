// The two partners of hob. Client-safe (no server imports): every module that
// asks "who?" (task owner, stock location, expense payer, who handles an
// influencer or an income) uses these keys and labels. Never hardcode names.
export const PARTNERS = ["avia", "lior"] as const;
export type Partner = (typeof PARTNERS)[number];

export const PARTNER: Record<Partner, { label: string; letter: string; color: string }> = {
  avia: { label: "אביה", letter: "א", color: "#a25ddc" },
  lior: { label: "ליאור", letter: "ל", color: "#579bfc" },
};

export function isPartner(x: unknown): x is Partner {
  return x === "avia" || x === "lior";
}

export function partnerLabel(key: string): string {
  return isPartner(key) ? PARTNER[key].label : key === "both" ? "שתיהן" : key === "business" ? "העסק" : key;
}

// Task owner: one partner, both of them, or nobody yet.
export const OWNERS = ["", "avia", "lior", "both"] as const;
export type Owner = (typeof OWNERS)[number];
export const OWNER_LABEL: Record<Owner, string> = { "": "—", avia: "אביה", lior: "ליאור", both: "שתיהן" };

// Stock locations: where the physical items sit right now.
export const LOCATIONS = ["avia", "lior"] as const;
export type Location = (typeof LOCATIONS)[number];
export const LOCATION_LABEL: Record<Location, string> = { avia: "אצל אביה", lior: "אצל ליאור" };

// Expense payer: a partner from her own pocket, or the business account.
export const PAYERS = ["avia", "lior", "business"] as const;
export type Payer = (typeof PAYERS)[number];
export const PAYER_LABEL: Record<Payer, string> = { avia: "אביה", lior: "ליאור", business: "העסק" };
