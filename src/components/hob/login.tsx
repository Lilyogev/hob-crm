import { useState, type FormEvent } from "react";

import { useIvory } from "./theme";

export function HobLogin({ onSuccess }: { onSuccess: () => void }) {
  const ivory = useIvory();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        onSuccess();
        return;
      }
      setError(
        res.status === 429
          ? "יותר מדי ניסיונות — נסו שוב בעוד רבע שעה"
          : res.status === 401
            ? "סיסמה שגויה — נסו שוב"
            : "משהו השתבש, נסו שוב",
      );
    } catch {
      setError("בעיית תקשורת — בדקו את החיבור ונסו שוב");
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
          src={ivory ? "/assets/segula-logo-dark.png" : "/assets/segula-logo-white.png"}
          alt="SEGULA"
          className="mx-auto mb-3 h-12 w-auto"
        />
        <div dir="ltr" className="mb-7 text-center text-xs font-bold uppercase italic tracking-[0.18em] text-[var(--hob-faint)]">
          we do what we want
        </div>
        <label className="mb-1.5 block text-sm font-medium text-[var(--hob-ink)]" htmlFor="pw">
          סיסמה
        </label>
        <input
          id="pw"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
          className="mb-3 h-11 w-full rounded-lg border border-[var(--hob-rule-strong)] px-3 outline-none focus:border-[var(--hob-accent)]"
        />
        {error && <div className="mb-3 text-sm text-[#e2445c]">{error}</div>}
        <button
          type="submit"
          disabled={busy || !password}
          className="h-11 w-full rounded-lg bg-[var(--hob-accent)] font-bold text-[var(--hob-accent-fg)] transition-colors hover:bg-[var(--hob-accent-hover)] disabled:opacity-50"
        >
          {busy ? "רגע…" : "כניסה ללוח"}
        </button>
        <div dir="ltr" className="mt-6 text-center text-[11px] tracking-[0.08em] text-[var(--hob-faint)]">
          SEGULA CLUB &amp; Co.
        </div>
      </form>
    </div>
  );
}
