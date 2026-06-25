import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { getLoginUrl } from "@/const";
import { Link } from "wouter";
import {
  History, Send, CheckCircle2, XCircle, Clock, Loader2, ArrowRight,
  AlertCircle, ChevronRight, FlaskConical
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

export default function BroadcastHistory() {
  const { isAuthenticated, loading: authLoading } = useAuth();
  const { data: broadcasts, isLoading } = trpc.broadcast.list.useQuery(undefined, { enabled: isAuthenticated });

  if (authLoading) return <div className="flex h-full items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>;

  if (!isAuthenticated) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        <p className="text-muted-foreground">Please sign in to view broadcast history.</p>
        <a href={getLoginUrl()} className="inline-flex items-center gap-2 rounded-xl gradient-primary px-5 py-2.5 text-sm font-semibold text-white">
          Sign in <ArrowRight className="h-4 w-4" />
        </a>
      </div>
    );
  }

  return (
    <div className="p-6 lg:p-8 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Broadcast History</h1>
          <p className="text-sm text-muted-foreground mt-0.5">All past and active broadcast campaigns.</p>
        </div>
        <Link href="/launch">
          <button className="flex items-center gap-2 rounded-xl gradient-primary px-4 py-2 text-xs font-semibold text-white hover:opacity-90 transition-opacity">
            <Send className="h-3.5 w-3.5" />
            New Broadcast
          </button>
        </Link>
      </div>

      {isLoading ? (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="p-4 border-b border-border bg-muted/20">
            <div className="h-3.5 w-32 bg-muted rounded animate-pulse" />
          </div>
          {[...Array(4)].map((_, i) => (
            <div key={i} className="flex items-center gap-4 p-4 border-b border-border last:border-0 animate-pulse">
              <div className="h-9 w-9 rounded-lg bg-muted shrink-0" />
              <div className="flex-1 space-y-2">
                <div className="h-3.5 w-48 bg-muted rounded" />
                <div className="h-3 w-32 bg-muted rounded" />
              </div>
              <div className="h-5 w-20 bg-muted rounded-full" />
            </div>
          ))}
        </div>
      ) : !broadcasts || broadcasts.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-12 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-muted mx-auto mb-4">
            <History className="h-6 w-6 text-muted-foreground" />
          </div>
          <p className="text-base font-semibold text-foreground">No broadcasts yet</p>
          <p className="text-sm text-muted-foreground mt-1 max-w-xs mx-auto">
            Launch your first broadcast campaign to see it here.
          </p>
          <Link href="/launch">
            <button className="mt-5 inline-flex items-center gap-2 rounded-xl gradient-primary px-5 py-2.5 text-sm font-semibold text-white">
              <Send className="h-4 w-4" />
              Launch Broadcast
            </button>
          </Link>
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          {/* Table Header */}
          <div className="hidden sm:grid grid-cols-[1fr_auto_auto_auto_auto_auto] gap-4 px-4 py-3 border-b border-border bg-muted/20">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Campaign</span>
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider text-center">Recipients</span>
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider text-center">Sent</span>
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider text-center">Success Rate</span>
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider text-center">Status</span>
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider text-right">Date</span>
          </div>

          {/* Table Rows */}
          <div className="divide-y divide-border">
            {broadcasts.map((bc: any) => {
              const successRate = bc.totalRecipients > 0 && bc.status === "completed"
                ? bc.successRate != null ? bc.successRate : Math.round((bc.sentCount / bc.totalRecipients) * 100)
                : null;

              return (
                <Link key={bc.id} href={`/history/${bc.id}`}>
                  <div className="group flex flex-col sm:grid sm:grid-cols-[1fr_auto_auto_auto_auto_auto] sm:items-center gap-3 sm:gap-4 px-4 py-4 hover:bg-muted/20 cursor-pointer transition-colors">
                    {/* Campaign */}
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 shrink-0">
                        {bc.isDryRun ? <FlaskConical className="h-4 w-4 text-yellow-400" /> : <Send className="h-4 w-4 text-primary" />}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-foreground truncate">{bc.name}</p>
                        <p className="text-xs text-muted-foreground truncate max-w-xs">
                          {bc.message.slice(0, 60)}{bc.message.length > 60 ? "…" : ""}
                        </p>
                      </div>
                    </div>

                    {/* Mobile: stats row */}
                    <div className="flex items-center gap-3 sm:hidden flex-wrap">
                      <span className="text-xs text-muted-foreground">{bc.totalRecipients.toLocaleString()} recipients</span>
                      <StatusBadge status={bc.status} />
                      {successRate != null && (
                        <span className={cn("text-xs font-semibold", successRate >= 90 ? "text-emerald-400" : successRate >= 70 ? "text-yellow-400" : "text-red-400")}>
                          {successRate}%
                        </span>
                      )}
                    </div>

                    {/* Desktop columns */}
                    <span className="hidden sm:block text-sm font-medium text-foreground text-center">
                      {bc.totalRecipients.toLocaleString()}
                    </span>
                    <span className="hidden sm:block text-sm text-center">
                      <span className="text-emerald-400 font-medium">{bc.sentCount.toLocaleString()}</span>
                      {bc.failedCount > 0 && <span className="text-red-400 text-xs"> / {bc.failedCount}</span>}
                    </span>
                    <span className="hidden sm:block text-sm font-semibold text-center">
                      {successRate != null ? (
                        <span className={cn(successRate >= 90 ? "text-emerald-400" : successRate >= 70 ? "text-yellow-400" : "text-red-400")}>
                          {successRate}%
                        </span>
                      ) : "—"}
                    </span>
                    <span className="hidden sm:flex sm:justify-center">
                      <StatusBadge status={bc.status} />
                    </span>
                    <div className="hidden sm:flex items-center justify-end gap-2">
                      <span className="text-xs text-muted-foreground text-right">
                        {new Date(bc.createdAt).toLocaleDateString()}<br />
                        <span className="text-[10px]">{new Date(bc.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                      </span>
                      <ChevronRight className="h-4 w-4 text-muted-foreground/50 group-hover:text-primary transition-colors" />
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
