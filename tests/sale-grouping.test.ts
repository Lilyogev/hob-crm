// קיבוץ יומן המכירות לפי קונה (29.9.2026): אריאל קצמן פוצל לשתי שורות כי הטלפון
// נרשם פעם 0544405041 ופעם +972544405041. אותו מספר בכל פורמט = אותו אדם,
// ושני אנשים שונים עם אותו שם עדיין נשארים נפרדים.
import { expect, test } from "vitest";
import { contactKey, saleGroupKey, type SeedSale } from "../src/components/hob/seeding/shared";

const POPUP = "פופ-אפ";
const sale = (id: number, buyer: string, buyer_phone = "", buyer_email = "") =>
  ({ id, buyer, buyer_phone, buyer_email }) as SeedSale;

test("אותו טלפון בפורמטים שונים הוא אותו מספר", () => {
  expect(contactKey("0544405041")).toBe("0544405041");
  expect(contactKey("+972544405041")).toBe("0544405041");
  expect(contactKey("054-440-5041")).toBe("0544405041");
  expect(contactKey("972 54 440 5041")).toBe("0544405041");
});

test("בלי טלפון המייל קובע, בלי הבדל באותיות גדולות", () => {
  expect(contactKey("", "DeanOrenz96@Gmail.com ")).toBe("deanorenz96@gmail.com");
});

test("אריאל קצמן: שתי ההזמנות באותה שורה", () => {
  const a = saleGroupKey(sale(41, "Ariel Katzman", "0544405041", "arielkatzman@icloud.com"), POPUP);
  const b = saleGroupKey(sale(181, "Ariel Katzman", "+972544405041", "arielkatzman@icloud.com"), POPUP);
  expect(a).toBe(b);
});

test("שתי דנה עם טלפונים שונים נשארות שתי שורות", () => {
  const a = saleGroupKey(sale(1, "דנה", "0501111111"), POPUP);
  const b = saleGroupKey(sale(2, "דנה", "0502222222"), POPUP);
  expect(a).not.toBe(b);
});

test("מכירת פופ-אפ אנונימית לא מתקבצת עם אף אחת", () => {
  expect(saleGroupKey(sale(7, POPUP), POPUP)).toBe("#7");
  expect(saleGroupKey(sale(8, ""), POPUP)).toBe("#8");
});
