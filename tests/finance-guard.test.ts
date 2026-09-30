import { expect, test } from "vitest";
import { financeDecisionAllowed } from "../src/lib/team.server";

test("אלכס במצב איכות נתונים: בקשת נתונים נזרקת, בעיה חדשה עם ראיה עוברת", () => {
  expect(financeDecisionAllowed({ question: "כמה נכנס משופיפיי מאז 6.8?", issue_kind: "data_request", evidence: "זיכוי אחרון 6.8" })).toBe(false);
  expect(financeDecisionAllowed({ question: "כמה נכנס?" })).toBe(false); // בלי הצהרה
  expect(financeDecisionAllowed({ question: "כפילות?", issue_kind: "new_issue", evidence: "" })).toBe(false); // בלי ראיה
  expect(financeDecisionAllowed({ question: "רישום כפול של הדוגמנית?", issue_kind: "new_issue", evidence: "25.8 דוגמנית נועה 200 ₪ ביט + 400 ₪ מזומן" })).toBe(true);
});
