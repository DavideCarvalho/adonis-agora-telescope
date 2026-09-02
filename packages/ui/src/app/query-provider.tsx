import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';

/**
 * The console's query client.
 *
 * Defaults chosen for a live read surface, not an app:
 *
 * - `staleTime: 0` — a revisit shows current data. A cached snapshot of what was
 *   true when the tab was last open is worse than a spinner in a debugging tool.
 * - `retry: false` — a failing endpoint should say so immediately. Silent retries
 *   turn "this endpoint is broken" into "this screen is slow", which is exactly the
 *   diagnosis this console exists to make easy.
 * - `refetchOnWindowFocus: false` — alt-tabbing back should not re-run the
 *   aggregation endpoints, which are the expensive ones.
 */
export function createTelescopeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 0,
        retry: false,
        refetchOnWindowFocus: false,
      },
    },
  });
}

/**
 * Wraps the console in a query client.
 *
 * The point is deduplication: several containers on one page legitimately read the
 * same source (the Overview's four stat tiles are all `pulse`), and without a shared
 * cache, splitting a page into self-fetching containers would multiply its requests
 * instead of parallelizing them.
 */
export function TelescopeQueryProvider({ children }: { children: React.ReactNode }) {
  // In state, not module scope: one client per tree, so a test rendering two
  // components does not leak cached data from one into the other.
  const [client] = useState(createTelescopeQueryClient);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
