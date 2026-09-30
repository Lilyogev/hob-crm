import { useEffect, useRef, useState, type FormEvent } from "react";

import { PARTNER, PARTNERS, type Partner } from "../../lib/partners";
import { useIvory } from "./theme";

export type LoginUser = { key: Partner; name: string };

// Two steps: who is logging in (two big buttons), then her password.
export function HobLogin({ onSuccess }: { onSuccess: (user: LoginUser) => void }) {
  const ivory = useIvory();
  const [who, setWho] = useState<Partner | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pwRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (who) pwRef.current?.focus();
  }, [who]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!who || !password || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user: who, password }),
      });
      if (res.ok) {
        const data = (await res.json()) as { user?: LoginUser };
        onSuccess(data.user ?? { key: who, name: PARTNER[who].label });
        return;
      }
      setError(
        res.status === 429
          ? "יותר מדי ניסיונות. נסו שוב בעוד רבע שעה"
          : res.status === 401
            ? "סיסמה שגויה. נסו שוב"
            : "משהו השתבש, נסו שוב",
      );
    } catch {
      setError("בעיית תקשורת. בדקו את החיבור ונסו שוב");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-2xl border border-[var(--hob-rule-strong)] bg-[var(--hob-surface)] p-8 shadow-sm"
      >
        <img
          src={ivory ? "/assets/hob-logo-dark.png" : "/assets/hob-logo-light.png"}
          alt="hob"
          className="mx-auto mb-8 h-14 w-auto"
        />

        <div className="mb-2 text-center text-sm font-medium text-[var(--hob-soft)]">מי נכנסת?</div>
        <div className="mb-5 grid grid-cols-2 gap-3">
          {PARTNERS.map((key) => {
            const active = who === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => {
                  setWho(key);
                  setError("");
                }}
                className={`flex h-20 flex-col items-center justify-center gap-1 rounded-xl border-2 text-lg font-bold transition-colors ${
                  active
                    ? "border-[var(--hob-accent)] bg-[var(--hob-accent)] text-[var(--hob-accent-fg)]"
                    : "border-[var(--hob-rule-strong)] text-[var(--hob-ink)] hover:bg-[var(--hob-hover)]"
                }`}
              >
                <span
                  className="flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold text-white"
                  style={{ backgroundColor: PARTNER[key].color }}
                >
                  {PARTNER[key].letter}
                </span>
                {PARTNER[key].label}
              </button>
            );
          })}
        </div>

        {who && (
          <>
            <label className="mb-1.5 block text-sm font-medium text-[var(--hob-ink)]" htmlFor="pw">
              הסיסמה של {PARTNER[who].label}
            </label>
            <input
              id="pw"
              ref={pwRef}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mb-3 h-11 w-full rounded-lg border border-[var(--hob-rule-strong)] px-3 outline-none focus:border-[var(--hob-accent)]"
            />
          </>
        )}
        {error && <div className="mb-3 text-sm text-[#e2445c]">{error}</div>}
        <button
          type="submit"
          disabled={busy || !who || !password}
          className="h-11 w-full rounded-lg bg-[var(--hob-accent)] font-bold text-[var(--hob-accent-fg)] transition-colors hover:bg-[var(--hob-accent-hover)] disabled:opacity-50"
        >
          {busy ? "רגע…" : "כניסה ללוח"}
        </button>
        <div dir="ltr" className="mt-6 text-center text-[11px] tracking-[0.08em] text-[var(--hob-faint)]">
          House of Bais
        </div>
      </form>
    </div>
  );
}
