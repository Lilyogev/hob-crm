import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import { HobBoard, type BoardUser } from "../components/hob/board";
import { HobLogin } from "../components/hob/login";
import { initTheme } from "../components/hob/theme";

export const Route = createFileRoute("/")({
  component: Index,
});

function Index() {
  // undefined = still checking; null = not logged in. The check runs
  // client-side only (SSR-safe). The user is React state, never localStorage:
  // the API reads the actor from the session cookie anyway.
  const [user, setUser] = useState<BoardUser | null | undefined>(undefined);

  useEffect(() => {
    initTheme(); // the theme picked before comes back before the screen loads
    let cancelled = false;
    fetch("/api/me")
      .then((r) => r.json() as Promise<{ authed?: boolean; user?: BoardUser | null }>)
      .then((data) => {
        if (!cancelled) setUser(data.authed && data.user ? data.user : null);
      })
      .catch(() => {
        if (!cancelled) setUser(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onAuthLost = useCallback(() => setUser(null), []);
  const onLogin = useCallback((u: BoardUser) => setUser(u), []);

  if (user === undefined) {
    return (
      <div className="flex min-h-dvh items-center justify-center text-[var(--hob-faint)]">
        טוען…
      </div>
    );
  }
  return user ? <HobBoard user={user} onAuthLost={onAuthLost} /> : <HobLogin onSuccess={onLogin} />;
}
