import { trpc } from "@/lib/trpc";
import {
  QueryClient,
  QueryClientProvider,
  onlineManager,
} from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { createRoot } from "react-dom/client";
import superjson from "superjson";
import App from "./App";
import "./index.css";
import {
  createRpcFetch,
  shouldRetryRead,
  readRetryDelay,
  canRefetchRead,
} from "@/lib/networkRecovery";

onlineManager.setOnline(navigator.onLine);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: shouldRetryRead,
      retryDelay: readRetryDelay,
      refetchOnWindowFocus: canRefetchRead,
      refetchOnReconnect: canRefetchRead,
    },
    mutations: { retry: false },
  },
});

const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: "/api/trpc",
      transformer: superjson,
      fetch: createRpcFetch(),
    }),
  ],
});

createRoot(document.getElementById("root")!).render(
  <trpc.Provider client={trpcClient} queryClient={queryClient}>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </trpc.Provider>
);
