import { MutationCache, QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { toast } from "./components/hob/toast";

export const getRouter = () => {
  const queryClient = new QueryClient({
    // Every failed save anywhere in the app (board, seeding, finance, chat)
    // used to disappear silently — the optimistic UI just snapped back on the
    // next refetch. One global handler turns that into a visible red toast.
    // 401 is excluded: the views already switch to the login screen for it.
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        if ((error as Error).message === "unauthorized") return;
        // Mutations that run a real-world action report their own outcome: a
        // blanket "try again" there invites a second execution.
        if (mutation.meta?.ownErrorMessage) return;
        toast("השמירה נכשלה — בדקו את החיבור ונסו שוב", "error");
      },
    }),
  });

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
  });

  return router;
};
