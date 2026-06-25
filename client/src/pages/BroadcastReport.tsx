import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { getLoginUrl } from "@/const";
import { Link, useParams } from "wouter";
import {
  ArrowLeft, Download, CheckCircle2, XCircle, Clock, Loader2, Send,
  Users, TrendingUp, AlertCircle, FlaskConical, FileJson
} from "lucide-react";
import { cn } from "@/lib/utils";

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { cls: string; icon: React.ReactNode; label: string }> = {
    completed: { cls: "badge-success", icon: <CheckCircle2 className="h-3 w-3" />, label: "Completed" },
    failed: { cls: "badge-failed", icon: <XCircle className="h-3 w-3" />, label: "Failed" },
    running: { cls: "badge-running", icon: <Loader2 className="h-3 w-3 animate-spin" />, label: "Running" },
    pending: { cls: "badge-pending", icon: <Clock className="h-3 w-3" />, label: "Pending" },
    cancelled: { cls: "badge-cancelled", icon: <AlertCircle className="h-3 w-3" />, label: "Cancelled" },
  };
  const { cls, icon, label } = map[status] ?? map.pending;
  return <span className={cls}>{icon}{label}</span>;
}

export default function BroadcastReport() {
  const { id } = useParams<{ id: string }>();
  const broadcastId = parseInt(id ?? "0", 10);
  const { isAuthenticated, loading: authLoading } = useAuth();

  const { data: broadcast, isLoading: bcLoading } = trpc.broadcast.get.useQuery(
    { id: broadcastId },
    { enabled: isAuthenticated && !!broadcastId }
  );
  const { data: logs, isLoading: logsLoading } = trpc.broadcast.getLogs.useQuery(
    { id: broadcastId },
    { enabled: isAuthenticated && !!broadcastId }
  );

  const handleDownload = () => {
    if (!broadcast || !logs) return;
    const report = {
      broadcast: {
        id: broadcast.id,
        name: broadcast.name,
        status: broadcast.status,
        parseMode: broadcast.parseMode,
        delaySeconds: broadcast.delaySeconds,
        isDryRun: broadcast.isDryRun,
        totalRecipients: broadcast.totalRecipients,
        sentCount: broadcast.sentCount,
        failedCount: broadcast.failedCount,
        successRate: broadcast.successRate,
        startedAt: broadcast.startedAt,
        completedAt: broadcast.completedAt,
        createdAt: broadcast.createdAt,
      },
      logs: logs.map((l: any) => ({
        chatId: l.chatId,
        success: l.success,
        errorMessage: l.errorMessage ?? null,
        sentAt: l.sentAt,
      })),
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `broadcast-report-${broadcast.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (authLoading || bcLoading) {
    return <div className="flex h-full items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>;
  }

  if (!isAuthenticated) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        <p className="text-muted-foreground">Please sign in to view broadcast reports.</p>
        <a href={getLoginUrl()} className="inline-flex items-center gap-2 rounded-xl gradient-primary px-5 py-2.5 text-sm font-semibold text-white">
          Sign in
        </a>
      </div>
    );
  }

  if (!broadcast) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        <p className="text-muted-foreground">Broadcast not found.</p>
        <Link href="/history">
          <button className="inline-flex items-center gap-2 rounded-xl gradient-primary px-5 py-2.5 text-sm font-semibold text-white">
            <ArrowLeft className="h-4 w-4" />Back to History
          </button>
        </Link>
      </div>
    );
  }

  const successRate = broadcast.successRate ??
    (broadcast.totalRecipients > 0 ? Math.round((broadcast.sentCount / broadcast.totalRecipients) * 100) : 0);

  const successLogs = logs?.filter((l: any) => l.success) ?? [];
  const failedLogs = logs?.filter((l: any) => !l.success) ?? [];

  return (
    <div className="p-6 lg:p-8 max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <Link href="/history">
            <button className="rounded-lg p-2 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
              <ArrowLeft className="h-4 w-4" />
            </button>
          </Link>
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-2xl font-bold text-foreground">{broadcast.name}</h1>
              {broadcast.isDryRun && (
                <span className="flex items-center gap-1 rounded-full bg-yellow-500/15 border border-yellow-500/25 px-2 py-0.5 text-xs font-medium text-yellow-400">
                  <FlaskConical className="h-3 w-3" />Dry Run
                </span>
              )}
            </div>
            <p className="text-sm text-muted-foreground mt-0.5">
              Created {new Date(broadcast.createdAt).toLocaleString()}
            </p>
          </div>
        </div>
        <button
          onClick={handleDownload}
          className="flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-2 text-xs font-semibold text-foreground hover:bg-muted transition-colors shrink-0"
        >
          <Download className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Download</span> JSON
        </button>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "Total Recipients", value: broadcast.totalRecipients.toLocaleString(), icon: Users, color: "text-foreground", bg: "bg-muted" },
          { label: "Sent", value: broadcast.sentCount.toLocaleString(), icon: Send, color: "text-emerald-400", bg: "bg-emerald-500/10" },
          { label: "Failed", value: broadcast.failedCount.toLocaleString(), icon: XCircle, color: "text-red-400", bg: "bg-red-500/10" },
          { label: "Success Rate", value: `${successRate}%`, icon: TrendingUp, color: successRate >= 90 ? "text-emerald-400" : successRate >= 70 ? "text-yellow-400" : "text-red-400", bg: "bg-primary/10" },
        ].map(({ label, value, icon: Icon, color, bg }) => (
          <div key={label} className="rounded-xl border border-border bg-card p-4">
            <div className={cn("flex h-8 w-8 items-center justify-center rounded-lg mb-3", bg)}>
              <Icon className={cn("h-4 w-4", color)} />
            </div>
            <p className={cn("text-xl font-bold", color)}>{value}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
          </div>
        ))}
      </div>

      {/* Broadcast Details */}
      <div className="rounded-xl border border-border bg-card p-5 space-y-3">
        <h2 className="text-sm font-semibold text-foreground">Broadcast Details</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
          {[
            { label: "Status", value: <StatusBadge status={broadcast.status} /> },
            { label: "Parse Mode", value: <code className="font-mono text-primary">{broadcast.parseMode}</code> },
            { label: "Delay", value: `${broadcast.delaySeconds}s between sends` },
            { label: "Started", value: broadcast.startedAt ? new Date(broadcast.startedAt).toLocaleString() : "—" },
            { label: "Completed", value: broadcast.completedAt ? new Date(broadcast.completedAt).toLocaleString() : "—" },
            { label: "Mode", value: broadcast.isDryRun ? "Dry Run (simulated)" : "Live" },
          ].map(({ label, value }) => (
            <div key={label} className="rounded-lg bg-muted/30 p-3">
              <p className="text-muted-foreground mb-1">{label}</p>
              <div className="font-medium text-foreground">{value}</div>
            </div>
          ))}
        </div>
        <div>
          <p className="text-xs text-muted-foreground mb-1.5">Message</p>
          <div className="rounded-lg bg-muted/30 px-3 py-2.5 text-xs font-mono text-muted-foreground max-h-24 overflow-y-auto">
            {broadcast.message}
          </div>
        </div>
      </div>

      {/* Per-message Log */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-foreground">
            Per-message Log
            {logs && <span className="ml-2 text-muted-foreground font-normal">({logs.length.toLocaleString()} entries)</span>}
          </h2>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="flex items-center gap-1"><CheckCircle2 className="h-3 w-3 text-emerald-400" />{successLogs.length.toLocaleString()}</span>
            <span className="flex items-center gap-1"><XCircle className="h-3 w-3 text-red-400" />{failedLogs.length.toLocaleString()}</span>
          </div>
        </div>

        {logsLoading ? (
          <div className="rounded-xl border border-border bg-card divide-y divide-border">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="flex items-center gap-3 p-3 animate-pulse">
                <div className="h-5 w-5 rounded-full bg-muted shrink-0" />
                <div className="h-3 w-32 bg-muted rounded" />
                <div className="ml-auto h-3 w-24 bg-muted rounded" />
              </div>
            ))}
          </div>
        ) : !logs || logs.length === 0 ? (
          <div className="rounded-xl border border-border bg-card p-8 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-muted mx-auto mb-3">
              <FileJson className="h-5 w-5 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium text-foreground">No message logs yet</p>
            <p className="text-xs text-muted-foreground mt-1">Logs will appear here once the broadcast runs.</p>
          </div>
        ) : (
          <div className="rounded-xl border border-border bg-card overflow-hidden">
            {/* Header */}
            <div className="grid grid-cols-[auto_1fr_auto_auto] gap-3 px-4 py-2.5 border-b border-border bg-muted/20">
              <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider w-5" />
              <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Chat ID</span>
              <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Error</span>
              <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider text-right">Time</span>
            </div>
            <div className="divide-y divide-border max-h-96 overflow-y-auto">
              {logs.map((log: any) => (
                <div key={log.id} className="grid grid-cols-[auto_1fr_auto_auto] gap-3 items-center px-4 py-2.5">
                  <div className="w-5 flex justify-center">
                    {log.success
                      ? <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                      : <XCircle className="h-4 w-4 text-red-400 shrink-0" />
                    }
                  </div>
                  <code className="text-xs font-mono text-foreground truncate">{log.chatId}</code>
                  <span className="text-xs text-muted-foreground truncate max-w-[200px]">
                    {log.errorMessage ?? (log.success ? "—" : "Unknown error")}
                  </span>
                  <span className="text-[10px] text-muted-foreground text-right whitespace-nowrap">
                    {new Date(log.sentAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
