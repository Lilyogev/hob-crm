import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import { HobBoard } from "../components/hob/board";
import { HobLogin } from "../components/hob/login";
import { initTheme } from "../components/hob/theme";

export const Route = createFileRoute("/")({
  component: Index,
});

function Index() {
  // null = still checking; the check runs client-side only (SSR-safe).
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    initTheme(); // שנהב שנבחר בעבר חוזר לפני שהמסך נטען
    let cancelled = false;
    fetch("/api/me")
      .then((r) => r.json() as Promise<{ authed?: boolean }>)
      .then((data) => {
        if (!cancelled) setAuthed(Boolean(data.authed));
      })
      .catch(() => {
        if (!cancelled) setAuthed(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onAuthLost = useCallback(() => setAuthed(false), []);
  const onLogin = useCallback(() => setAuthed(true), []);

  if (authed === null) {
    return (
      <div className="flex min-h-dvh items-center justify-center text-[var(--hob-faint)]">
        טוען…
      </div>
    );
  }
  return authed ? <HobBoard onAuthLost={onAuthLost} /> : <HobLogin onSuccess={onLogin} />;
}
