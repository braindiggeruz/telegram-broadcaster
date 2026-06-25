import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { getLoginUrl } from "@/const";
import { Link } from "wouter";
import {
  Send, Users, CheckCircle2, TrendingUp, Rocket, Bot, MessageSquare, History,
  ArrowRight, Clock, AlertCircle, CheckCircle, XCircle, Loader2, RefreshCw
} from "lucide-react";
import { cn } from "@/lib/utils";

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    completed: "badge-success",
    failed: "badge-failed",
    running: "badge-running",
    pending: "badge-pending",
    cancelled: "badge-cancelled",
  };
  const icons: Record<string, React.ReactNode> = {
    completed: <CheckCircle className="h-3 w-3" />,
    failed: <XCircle className="h-3 w-3" />,
    running: <Loader2 className="h-3 w-3 animate-spin" />,
    pending: <Clock className="h-3 w-3" />,
    cancelled: <AlertCircle className="h-3 w-3" />,
  };
  return (
    <span className={map[status] ?? "badge-pending"}>
      {icons[status]}
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

function StatCard({ icon: Icon, label, value, sub, gradient }: {
  icon: React.ElementType; label: string; value: string | number; sub?: string; gradient: string;
}) {
  return (
    <div className="stat-card fade-in">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">{label}</p>
          <p className="text-3xl font-bold text-foreground">{value}</p>
          {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
        </div>
        <div className={cn("flex h-11 w-11 items-center justify-center rounded-xl", gradient)}>
          <Icon className="h-5 w-5 text-white" />
        </div>
      </div>
    </div>
  );
}

export default function DashboardHome() {
  const { user, loading: authLoading, isAuthenticated } = useAuth();
  const { data: stats, isLoading, refetch } = trpc.stats.dashboard.useQuery(undefined, {
    enabled: isAuthenticated,
    refetchInterval: 10000,
  });

  if (authLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-6 p-8 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl gradient-primary glow-primary">
          <Send className="h-8 w-8 text-white" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-foreground">Telegram Broadcaster</h1>
          <p className="text-muted-foreground mt-2 max-w-sm">
            Professional broadcast management for Telegram bots. Sign in to get started.
          </p>
        </div>
        <a
          href={getLoginUrl()}
          className="inline-flex items-center gap-2 rounded-xl gradient-primary px-6 py-3 text-sm font-semibold text-white shadow-lg hover:opacity-90 transition-opacity"
        >
          Sign in to continue
          <ArrowRight className="h-4 w-4" />
        </a>
      </div>
    );
  }

  const totalBroadcasts = stats?.totalBroadcasts ?? 0;
  const totalMessagesSent = stats?.totalMessagesSent ?? 0;
  const overallSuccessRate = stats?.overallSuccessRate ?? 0;
  const recent = stats?.recentBroadcasts ?? [];

  return (
    <div className="p-6 lg:p-8 space-y-8 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Dashboard</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Welcome back{user?.name ? `, ${user.name}` : ""}. Here's your broadcast overview.
          </p>
        </div>
        <button
          onClick={() => refetch()}
          className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </button>
      </div>

      {/* Stats Grid */}
      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="stat-card animate-pulse">
              <div className="h-4 w-24 bg-muted rounded mb-3" />
              <div className="h-8 w-16 bg-muted rounded" />
            </div>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <StatCard
            icon={Send}
            label="Total Broadcasts"
            value={totalBroadcasts}
            sub="All time campaigns"
            gradient="gradient-primary"
          />
          <StatCard
            icon={Users}
            label="Messages Sent"
            value={totalMessagesSent.toLocaleString()}
            sub="Successful deliveries"
            gradient="gradient-success"
          />
          <StatCard
            icon={TrendingUp}
            label="Overall Success Rate"
            value={`${overallSuccessRate}%`}
            sub="Across all broadcasts"
            gradient="bg-gradient-to-br from-violet-500 to-purple-600"
          />
        </div>
      )}

      {/* Quick Actions */}
      <div>
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-4">Quick Actions</h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[
            { href: "/bot-token", icon: Bot, label: "Configure Bot", desc: "Set up your token" },
            { href: "/recipients", icon: Users, label: "Upload Recipients", desc: "Import chat IDs" },
            { href: "/composer", icon: MessageSquare, label: "Compose Message", desc: "Write your message" },
            { href: "/launch", icon: Rocket, label: "Launch Broadcast", desc: "Send to recipients" },
          ].map(({ href, icon: Icon, label, desc }) => (
            <Link key={href} href={href}>
              <div className="group rounded-xl border border-border bg-card p-4 cursor-pointer hover:border-primary/40 hover:bg-card/80 transition-all duration-200">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 mb-3 group-hover:bg-primary/20 transition-colors">
                  <Icon className="h-4 w-4 text-primary" />
                </div>
                <p className="text-sm font-semibold text-foreground">{label}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{desc}</p>
              </div>
            </Link>
          ))}
        </div>
      </div>

      {/* Recent Activity */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Recent Activity</h2>
          <Link href="/history">
            <span className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 cursor-pointer">
              View all <ArrowRight className="h-3 w-3" />
            </span>
          </Link>
        </div>

        {isLoading ? (
          <div className="rounded-xl border border-border bg-card divide-y divide-border">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="flex items-center gap-4 p-4 animate-pulse">
                <div className="h-9 w-9 rounded-lg bg-muted" />
                <div className="flex-1 space-y-2">
                  <div className="h-3.5 w-40 bg-muted rounded" />
                  <div className="h-3 w-24 bg-muted rounded" />
                </div>
              </div>
            ))}
          </div>
        ) : recent.length === 0 ? (
          <div className="rounded-xl border border-border bg-card p-10 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-muted mx-auto mb-3">
              <History className="h-5 w-5 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium text-foreground">No broadcasts yet</p>
            <p className="text-xs text-muted-foreground mt-1">Launch your first broadcast to see activity here.</p>
            <Link href="/launch">
              <button className="mt-4 inline-flex items-center gap-2 rounded-lg gradient-primary px-4 py-2 text-xs font-semibold text-white">
                <Rocket className="h-3.5 w-3.5" />
                Launch Broadcast
              </button>
            </Link>
          </div>
        ) : (
          <div className="rounded-xl border border-border bg-card divide-y divide-border overflow-hidden">
            {recent.map((bc: any) => (
              <Link key={bc.id} href={`/history/${bc.id}`}>
                <div className="flex items-center gap-4 p-4 hover:bg-muted/30 cursor-pointer transition-colors">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 shrink-0">
                    <Send className="h-4 w-4 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{bc.name}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {bc.totalRecipients} recipients · {new Date(bc.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    {bc.status === "completed" && (
                      <span className="text-xs text-muted-foreground">
                        {bc.successRate != null ? `${bc.successRate}%` : "—"}
                      </span>
                    )}
                    <StatusBadge status={bc.status} />
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
