import { createFileRoute } from "@tanstack/react-router";
import { changePassword, currentUser, getSettings, putSetting, unauthorized } from "../../lib/hob.server";

// The settings tab. GET = the editable keys + who is logged in. POST ops:
// "save" {values} writes validated keys into `settings`; "password"
// {current, next} changes the logged-in user's password.
export const SETTING_KEYS = [
  "brand_name",
  "assistant_name",
  "brand_context",
  "owner_context",
  "shop_domain",
  "store_url",
  "collab_domain",
  "collab_discount_pct",
  "collab_commission_pct",
  "vat_exempt",
  "fee_rates",
] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

const HOST_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/i;

/** Returns the cleaned value, or an error message (Hebrew) for the form. */
function validate(key: SettingKey, raw: unknown): { value: string } | { error: string } {
  const s = typeof raw === "string" ? raw.trim() : typeof raw === "number" || typeof raw === "boolean" ? String(raw) : "";
  switch (key) {
    case "brand_name":
      return s.length <= 80 ? { value: s || "House of Bais" } : { error: "שם המותג ארוך מדי" };
    case "assistant_name":
      return s.length <= 40 ? { value: s || "הובי" } : { error: "שם העוזרת ארוך מדי" };
    case "brand_context":
    case "owner_context":
      return s.length <= 6000 ? { value: s } : { error: "הטקסט ארוך מדי (עד 6000 תווים)" };
    case "shop_domain":
    case "collab_domain": {
      const host = s.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase();
      return !host || HOST_RE.test(host) ? { value: host } : { error: "כתובת דומיין לא תקינה" };
    }
    case "store_url":
      if (!s) return { value: "" };
      return /^https:\/\/[^\s]+$/i.test(s) && s.length <= 200 ? { value: s } : { error: "כתובת החנות צריכה להתחיל ב-https://" };
    case "collab_discount_pct":
    case "collab_commission_pct": {
      const n = Number(s);
      return Number.isFinite(n) && n >= 0 && n <= 100 ? { value: String(Math.round(n)) } : { error: "אחוז בין 0 ל-100" };
    }
    case "vat_exempt":
      return { value: s === "1" || s === "true" ? "1" : "0" };
    case "fee_rates": {
      // The form sends one number: the Shopify clearing fee in percent.
      const n = Number(s);
      if (!Number.isFinite(n) || n < 0 || n > 20) return { error: "עמלת סליקה בין 0 ל-20 אחוז" };
      return { value: JSON.stringify({ shopify: Math.round(n * 100) / 10000 }) };
    }
  }
}

export const Route = createFileRoute("/api/settings")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const user = await currentUser(request);
        if (!user) return unauthorized();
        const settings = await getSettings(SETTING_KEYS);
        return Response.json({ ok: true, settings, user: { key: user.key, name: user.name } });
      },
      POST: async ({ request }) => {
        const user = await currentUser(request);
        if (!user) return unauthorized();
        const body = (await request.json().catch(() => ({}))) as { op?: string; values?: Record<string, unknown>; current?: unknown; next?: unknown };
        if (body.op === "password") {
          const current = typeof body.current === "string" ? body.current : "";
          const next = typeof body.next === "string" ? body.next : "";
          if (!current || !next) return Response.json({ ok: false, code: "bad_request" }, { status: 400 });
          const r = await changePassword(user.id, current, next);
          return Response.json(r, { status: r.ok ? 200 : 400 });
        }
        if (body.op === "save" && body.values && typeof body.values === "object") {
          const errors: Record<string, string> = {};
          const clean: Partial<Record<SettingKey, string>> = {};
          for (const key of SETTING_KEYS) {
            if (!(key in body.values)) continue;
            const v = validate(key, body.values[key]);
            if ("error" in v) errors[key] = v.error;
            else clean[key] = v.value;
          }
          if (Object.keys(errors).length) return Response.json({ ok: false, code: "invalid", errors }, { status: 400 });
          for (const [key, value] of Object.entries(clean)) await putSetting(key, value as string);
          return Response.json({ ok: true, settings: await getSettings(SETTING_KEYS) });
        }
        return Response.json({ ok: false, code: "bad_request" }, { status: 400 });
      },
    },
  },
});
