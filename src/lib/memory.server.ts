// Hobi's long-term memory: one row per fact in brand_memory (0001_core).
// "remember" adds, "forget" deletes by id, and the whole list goes into the
// stable block of her system prompt (newest last, capped so it never swells).
import type { D1Database } from "@cloudflare/workers-types";

export type MemoryFact = { id: number; fact: string; actor: string; created_at: string };

const MAX_FACTS_IN_PROMPT = 80;
const MAX_FACT_CHARS = 400;

export async function addMemory(db: D1Database, fact: string, actor = ""): Promise<number> {
  const text = fact.trim().slice(0, MAX_FACT_CHARS);
  if (!text) return 0;
  const res = await db
    .prepare("INSERT INTO brand_memory (fact, actor) VALUES (?, ?) RETURNING id")
    .bind(text, actor.slice(0, 20))
    .first<{ id: number }>();
  return res?.id ?? 0;
}

export async function listFacts(db: D1Database): Promise<MemoryFact[]> {
  try {
    const res = await db
      .prepare("SELECT id, fact, actor, created_at FROM brand_memory ORDER BY id")
      .all<MemoryFact>();
    return res.results ?? [];
  } catch {
    return [];
  }
}

export async function forget(db: D1Database, id: number): Promise<boolean> {
  const res = await db.prepare("DELETE FROM brand_memory WHERE id = ?").bind(id).run();
  return (res.meta?.changes ?? 0) > 0;
}

/** The memory as prompt text: "#id (date, who): fact" per line, or "" when empty. */
export async function memoryForPrompt(db: D1Database): Promise<string> {
  const facts = await listFacts(db);
  return facts
    .slice(-MAX_FACTS_IN_PROMPT)
    .map((f) => `#${f.id} (${f.created_at.slice(0, 10)}${f.actor ? `, ${f.actor}` : ""}): ${f.fact}`)
    .join("\n");
}
