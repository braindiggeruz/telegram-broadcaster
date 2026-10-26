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

function Router() {
  const session = trpc.auth.me.useQuery(undefined, {
    retry: false,
    refetchInterval: 60000,
  });
  if (session.isLoading)
    return (
      <div className="min-h-screen flex items-center justify-center text-sm text-muted-foreground">
        Загружаем TG Sender…
      </div>
    );
  if (session.error)
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 p-6">
        <p role="alert">Не удалось проверить доступ: {session.error.message}</p>
        <button
          className="text-primary underline"
          onClick={() => void session.refetch()}
        >
          Повторить
        </button>
      </div>
    );
  if (!session.data) return <Login />;
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
