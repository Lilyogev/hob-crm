import { beforeEach, expect, test } from "vitest";
import { freshDb } from "./d1";
import { flushHeldOrders, morningDigest, notify, setNotifyConfig } from "../src/lib/notify.server";

let db: ReturnType<typeof freshDb>;
const env = () => ({ DB: db as never });
// Israel is UTC+3 in September: 12:00Z = 15:00, 23:00Z = 02:00 at night.
const day = (h: number, m = 0) => new Date(Date.UTC(2026, 8, 17, h, m));
const pushes = async () => (await db.prepare("SELECT COUNT(*) AS n FROM push_outbox").first<{ n: number }>())?.n ?? -1;
beforeEach(() => {
  db = freshDb();
});

test("night orders wait for the morning digest", async () => {
  const r = await notify(env(), { level: "now", topic: "order", isOrder: true, title: "💸 הזמנה חדשה #1101 · 199 ₪", body: "דנה" }, day(23));
  expect(r).toEqual({ status: "held", reason: "quiet_hours" });
  expect(await pushes()).toBe(0);
  const d = await morningDigest(env(), { openDecisions: 0, topQuestion: "" }, day(5, 1));
  expect(d.sent).toBe(true);
  expect(await pushes()).toBe(1);
});

test("the daily cap holds the fourth alert, orders are not counted", async () => {
  for (let i = 0; i < 3; i++) expect((await notify(env(), { level: "now", topic: `t${i}`, title: `התראה ${i}` }, day(9, i))).status).toBe("sent");
  expect(await notify(env(), { level: "now", topic: "t4", title: "רביעית" }, day(10))).toEqual({ status: "held", reason: "daily_cap" });
  expect((await notify(env(), { level: "now", topic: "order", isOrder: true, title: "הזמנה" }, day(11))).status).toBe("sent");
});

test("one alert per topic, no nagging", async () => {
  expect((await notify(env(), { level: "now", topic: "unshipped:19", title: "הזמנה #19 מחכה יומיים" }, day(9))).status).toBe("sent");
  expect(await notify(env(), { level: "now", topic: "unshipped:19", title: "הזמנה #19 מחכה יומיים" }, day(14))).toEqual({ status: "dropped", reason: "duplicate" });
});

test("orders minutes apart become one alert that covers all of them", async () => {
  expect((await notify(env(), { level: "now", topic: "order", isOrder: true, title: "הזמנה #1", body: "א" }, day(9, 0))).status).toBe("sent");
  expect((await notify(env(), { level: "now", topic: "order", isOrder: true, title: "הזמנה #2", body: "ב" }, day(9, 3))).reason).toBe("coalesced");
  expect((await notify(env(), { level: "now", topic: "order", isOrder: true, title: "הזמנה #3", body: "ג" }, day(9, 6))).reason).toBe("coalesced");
  expect(await flushHeldOrders(env(), day(9, 10))).toBe(0); // window still open
  expect(await flushHeldOrders(env(), day(9, 17))).toBe(2);
  expect(await pushes()).toBe(2);
  const last = await db.prepare("SELECT title, body FROM push_outbox ORDER BY id DESC LIMIT 1").first<{ title: string; body: string }>();
  expect(last?.title).toContain("2 הזמנות");
  expect(last?.body).toContain("ב");
  expect(last?.body).toContain("ג");
  expect(await flushHeldOrders(env(), day(9, 30))).toBe(0); // never twice
});

test("silent items never push, a switched-off level drops, a quiet day sends nothing", async () => {
  expect((await notify(env(), { level: "silent", topic: "run", title: "דוח עובד" }, day(9))).status).toBe("logged");
  await setNotifyConfig(db as never, { levels: { now: false, morning: true, weekly: true } });
  expect(await notify(env(), { level: "now", topic: "x", title: "x" }, day(9))).toEqual({ status: "dropped", reason: "level_off" });
  expect(await pushes()).toBe(0);
  expect((await morningDigest(env(), { openDecisions: 0, topQuestion: "" }, day(5))).sent).toBe(false);
  expect(await pushes()).toBe(0);
});
