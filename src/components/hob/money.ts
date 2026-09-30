// One shekel formatter for the whole board.
//
// Every tab used to roll its own ("1,234 ₪" in finance, "₪1,234" in seeding,
// device-locale in delivery, no thousands separator in influencers), and two
// of them forgot demo mode (🥷), so showing the board to an outsider leaked
// influencer commissions and store invoices. Format: "₪1,234"; in demo
// mode: "₪•••" — the real number never enters the DOM.
import { isDemo } from "./demo";

export function nis(n: number): string {
  if (isDemo()) return "₪•••";
  return `₪${Math.round(n).toLocaleString("en-US")}`;
}
