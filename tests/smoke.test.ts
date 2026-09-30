import { expect, test } from "vitest";
import { freshDb } from "./d1";

test("all migrations apply to a fresh database", async () => {
  const db = freshDb();
  const row = await db.prepare("SELECT COUNT(*) AS n FROM team_decisions").first<{ n: number }>();
  expect(row?.n).toBe(0);
});
