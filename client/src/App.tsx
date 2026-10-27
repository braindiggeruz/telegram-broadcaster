import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import AppLayout from "./components/AppLayout";
import DashboardHome from "./pages/DashboardHome";
import BotToken from "./pages/BotToken";
import Recipients from "./pages/Recipients";
import Composer from "./pages/Composer";
import BroadcastLaunch from "./pages/BroadcastLaunch";
import BroadcastHistory from "./pages/BroadcastHistory";
import BroadcastReport from "./pages/BroadcastReport";
import UserAccount from "./pages/UserAccount";
import UserBroadcast from "./pages/UserBroadcast";
import Autopilot from "./pages/Autopilot";
import Login from "./pages/Login";
import { trpc } from "./lib/trpc";
import { onlineManager } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import ConnectionRecovery from "./components/ConnectionRecovery";
import {
  isTransientReadError,
  sessionQueryOptions,
} from "./lib/networkRecovery";

function Router() {
  const session = trpc.auth.me.useQuery(undefined, sessionQueryOptions);
  const isOnline = useSyncExternalStore(
    onlineManager.subscribe,
    () => onlineManager.isOnline(),
    () => true
  );
  // A failed background refresh must also close access while retries are pending.
  const sessionError = session.error ?? session.failureReason;
  if (
    session.isPending ||
    sessionError ||
    !session.isSuccess ||
    session.data === undefined
  )
    return (
      <ConnectionRecovery
        state={
          !isOnline || session.fetchStatus === "paused"
            ? "offline"
            : sessionError
              ? isTransientReadError(sessionError)
                ? "reconnecting"
                : "unavailable"
              : "checking"
        }
        isFetching={session.isFetching}
        onRetry={() => void session.refetch()}
      />
    );
  if (session.data === null) return <Login />;
  return (
    <AppLayout>
      <Switch>
        <Route path="/" component={DashboardHome} />
        <Route path="/bot-token" component={BotToken} />
        <Route path="/recipients" component={Recipients} />
        <Route path="/composer" component={Composer} />
        <Route path="/launch" component={BroadcastLaunch} />
        <Route path="/history" component={BroadcastHistory} />
        <Route path="/history/:id">
          <BroadcastReport />
        </Route>
        <Route path="/user-account" component={UserAccount} />
        <Route path="/user-broadcast" component={UserBroadcast} />
        <Route path="/user-broadcast-report/:id">
          <BroadcastReport transport="mtproto" />
        </Route>
        <Route path="/autopilot" component={Autopilot} />
        <Route path="/404" component={NotFound} />
        <Route component={NotFound} />
      </Switch>
    </AppLayout>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="dark">
        <TooltipProvider>
          <Toaster theme="dark" position="top-right" richColors />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
