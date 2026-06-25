import { useState, useEffect, useRef } from "react";
import { trpc } from "@/lib/trpc";
import { Link } from "wouter";
import {
  Rocket, Settings, Play, Square, CheckCircle2, XCircle, Clock, Loader2,
  Users, MessageSquare, Bot, ArrowRight, AlertTriangle, Zap, FlaskConical
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

type ParseMode = "HTML" | "Markdown" | "MarkdownV2" | "None";

export default function BroadcastLaunch() {

  const [name, setName] = useState(`Broadcast ${new Date().toLocaleDateString()}`);
  const [message, setMessage] = useState(() => sessionStorage.getItem("composer_message") || "");
  const [parseMode, setParseMode] = useState<ParseMode>(() => (sessionStorage.getItem("composer_mode") as ParseMode) || "HTML");
  const [delaySeconds, setDelaySeconds] = useState(1.0);
  const [isDryRun, setIsDryRun] = useState(false);
  const [selectedListId, setSelectedListId] = useState<number | null>(null);
  const [activeBroadcastId, setActiveBroadcastId] = useState<number | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { data: botSettings } = trpc.bot.get.useQuery(undefined, undefined);
  const { data: lists } = trpc.recipients.list.useQuery(undefined, undefined);

  const { data: progress, refetch: refetchProgress } = trpc.broadcast.getProgress.useQuery(
    { id: activeBroadcastId! },
    { enabled: !!activeBroadcastId, refetchInterval: activeBroadcastId ? 1000 : false }
  );

  const createMutation = trpc.broadcast.create.useMutation();
  const launchMutation = trpc.broadcast.launch.useMutation({
    onSuccess: () => toast.success("Broadcast started!"),
    onError: (err) => toast.error(err.message),
  });
  const cancelMutation = trpc.broadcast.cancel.useMutation({
    onSuccess: () => { toast.info("Broadcast cancelled"); setActiveBroadcastId(null); },
    onError: (err) => toast.error(err.message),
  });

  const isRunning = progress?.running && progress?.status === "running";
  const isFinished = progress && !progress.running && activeBroadcastId;

  const handleLaunch = async () => {
    if (!selectedListId) return toast.error("Please select a recipient list");
    if (!message.trim()) return toast.error("Please compose a message first");
    if (!botSettings?.isValid && !isDryRun) return toast.error("Please configure a valid bot token first");

    try {
      const bc = await createMutation.mutateAsync({
        name, message, parseMode, delaySeconds, isDryRun,
        recipientListId: selectedListId,
      });
      if (!bc) throw new Error("Failed to create broadcast");
      setActiveBroadcastId(bc.id);
      await launchMutation.mutateAsync({ id: bc.id });
    } catch (err: any) {
      toast.error(err.message ?? "Launch failed");
    }
  };

  const handleCancel = () => {
    if (activeBroadcastId) cancelMutation.mutate({ id: activeBroadcastId });
  };

  const selectedList = lists?.find((l: any) => l.id === selectedListId);
  const total = progress?.total ?? selectedList?.totalCount ?? 0;
  const sent = progress?.sent ?? 0;
  const failed = progress?.failed ?? 0;
  const remaining = Math.max(0, total - sent - failed);
  const progressPct = total > 0 ? Math.round(((sent + failed) / total) * 100) : 0;
  const successRate = (sent + failed) > 0 ? Math.round((sent / (sent + failed)) * 100) : 0;

  return (
    <div className="p-6 lg:p-8 max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Broadcast Launch</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Configure and launch your message broadcast campaign.</p>
      </div>

      {/* Progress Panel (shown when running or finished) */}
      {activeBroadcastId && progress && (
        <div className={cn(
          "rounded-xl border p-5 space-y-4 fade-in",
          isRunning ? "border-primary/30 bg-primary/5" :
          progress.status === "completed" ? "border-emerald-500/30 bg-emerald-500/5" :
          progress.status === "cancelled" ? "border-yellow-500/30 bg-yellow-500/5" :
          "border-red-500/30 bg-red-500/5"
        )}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              {isRunning ? (
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/15">
                  <Loader2 className="h-4 w-4 animate-spin text-primary" />
                </div>
              ) : progress.status === "completed" ? (
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/15">
                  <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                </div>
              ) : (
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-yellow-500/15">
                  <AlertTriangle className="h-4 w-4 text-yellow-400" />
                </div>
              )}
              <div>
                <p className="text-sm font-semibold text-foreground">
                  {isRunning ? "Broadcast in progress…" :
                   progress.status === "completed" ? "Broadcast completed!" :
                   progress.status === "cancelled" ? "Broadcast cancelled" : "Broadcast stopped"}
                </p>
                <p className="text-xs text-muted-foreground">{progressPct}% complete</p>
              </div>
            </div>
            {isRunning && (
              <button
                onClick={handleCancel}
                disabled={cancelMutation.isPending}
                className="flex items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-red-500/20 transition-colors"
              >
                <Square className="h-3.5 w-3.5" />
                Cancel
              </button>
            )}
          </div>

          {/* Progress Bar */}
          <div>
            <div className="h-2.5 rounded-full bg-muted overflow-hidden">
              <div
                className={cn("h-full rounded-full transition-all duration-500", isRunning ? "progress-animated" : progress.status === "completed" ? "bg-emerald-500" : "bg-yellow-500")}
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>

          {/* Stats Row */}
          <div className="grid grid-cols-4 gap-3">
            {[
              { label: "Total", value: total.toLocaleString(), icon: Users, color: "text-foreground" },
              { label: "Sent", value: sent.toLocaleString(), icon: CheckCircle2, color: "text-emerald-400" },
              { label: "Failed", value: failed.toLocaleString(), icon: XCircle, color: "text-red-400" },
              { label: "Remaining", value: remaining.toLocaleString(), icon: Clock, color: "text-primary" },
            ].map(({ label, value, icon: Icon, color }) => (
              <div key={label} className="rounded-lg bg-muted/40 p-3 text-center">
                <Icon className={cn("h-4 w-4 mx-auto mb-1", color)} />
                <p className={cn("text-lg font-bold", color)}>{value}</p>
                <p className="text-[10px] text-muted-foreground">{label}</p>
              </div>
            ))}
          </div>

          {isFinished && (
            <div className="flex items-center justify-between pt-1">
              <p className="text-xs text-muted-foreground">
                Success rate: <span className="font-semibold text-foreground">{successRate}%</span>
              </p>
              <Link href={`/history/${activeBroadcastId}`}>
                <span className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 cursor-pointer">
                  View full report <ArrowRight className="h-3 w-3" />
                </span>
              </Link>
            </div>
          )}
        </div>
      )}

      {/* Configuration Panel */}
      {!isRunning && (
        <div className="rounded-xl border border-border bg-card p-5 space-y-5">
          <div className="flex items-center gap-2">
            <Settings className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold text-foreground">Broadcast Configuration</h2>
          </div>

          {/* Campaign Name */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Campaign Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg border border-border bg-input px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/60 transition-all"
            />
          </div>

          {/* Recipient List */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Recipient List</label>
            {!lists || lists.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border p-4 text-center">
                <p className="text-xs text-muted-foreground">No recipient lists available.</p>
                <Link href="/recipients">
                  <span className="text-xs text-primary hover:text-primary/80 cursor-pointer">Upload a list →</span>
                </Link>
              </div>
            ) : (
              <div className="grid gap-2">
                {lists.map((list: any) => (
                  <button
                    key={list.id}
                    onClick={() => setSelectedListId(list.id)}
                    className={cn(
                      "flex items-center gap-3 rounded-lg border p-3 text-left transition-all duration-150",
                      selectedListId === list.id
                        ? "border-primary/50 bg-primary/10"
                        : "border-border hover:border-primary/30 hover:bg-muted/30"
                    )}
                  >
                    <div className={cn("flex h-8 w-8 items-center justify-center rounded-lg shrink-0",
                      selectedListId === list.id ? "bg-primary/20" : "bg-muted")}>
                      <Users className={cn("h-4 w-4", selectedListId === list.id ? "text-primary" : "text-muted-foreground")} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">{list.name}</p>
                      <p className="text-xs text-muted-foreground">{list.totalCount.toLocaleString()} recipients</p>
                    </div>
                    {selectedListId === list.id && <CheckCircle2 className="h-4 w-4 text-primary shrink-0" />}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Message Preview */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-muted-foreground">Message</label>
              <Link href="/composer">
                <span className="text-xs text-primary hover:text-primary/80 cursor-pointer flex items-center gap-1">
                  <MessageSquare className="h-3 w-3" />Edit in Composer
                </span>
              </Link>
            </div>
            {message ? (
              <div className="rounded-lg border border-border bg-muted/20 px-3 py-2.5 text-xs text-muted-foreground font-mono max-h-20 overflow-y-auto">
                {message.slice(0, 200)}{message.length > 200 ? "…" : ""}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-border p-4 text-center">
                <p className="text-xs text-muted-foreground">No message composed yet.</p>
                <Link href="/composer">
                  <span className="text-xs text-primary hover:text-primary/80 cursor-pointer">Go to Composer →</span>
                </Link>
              </div>
            )}
          </div>

          {/* Parse Mode */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Parse Mode</label>
            <div className="flex flex-wrap gap-2">
              {(["HTML", "Markdown", "MarkdownV2", "None"] as ParseMode[]).map((m) => (
                <button
                  key={m}
                  onClick={() => setParseMode(m)}
                  className={cn(
                    "rounded-lg border px-3 py-1.5 text-xs font-medium transition-all duration-150",
                    parseMode === m
                      ? "border-primary/50 bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:text-foreground hover:bg-muted"
                  )}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>

          {/* Delay Slider */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-muted-foreground">Delay Between Sends</label>
              <span className="text-xs font-semibold text-primary">{delaySeconds.toFixed(1)}s</span>
            </div>
            <input
              type="range"
              min={0.5}
              max={5}
              step={0.5}
              value={delaySeconds}
              onChange={(e) => setDelaySeconds(parseFloat(e.target.value))}
              className="w-full accent-primary cursor-pointer"
            />
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>0.5s (faster)</span>
              <span>5.0s (safer)</span>
            </div>
          </div>

          {/* Dry-run Mode */}
          <div className="flex items-center justify-between rounded-xl border border-border bg-muted/20 p-4">
            <div className="flex items-center gap-3">
              <div className={cn("flex h-9 w-9 items-center justify-center rounded-lg", isDryRun ? "bg-yellow-500/15" : "bg-muted")}>
                <FlaskConical className={cn("h-4 w-4", isDryRun ? "text-yellow-400" : "text-muted-foreground")} />
              </div>
              <div>
                <p className="text-sm font-medium text-foreground">Dry-run mode</p>
                <p className="text-xs text-muted-foreground">Simulate broadcast without sending real messages</p>
              </div>
            </div>
            <button
              onClick={() => setIsDryRun(!isDryRun)}
              className={cn(
                "relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200",
                isDryRun ? "bg-yellow-500" : "bg-muted"
              )}
            >
              <span className={cn(
                "inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform duration-200",
                isDryRun ? "translate-x-6" : "translate-x-1"
              )} />
            </button>
          </div>

          {/* Warnings */}
          {!botSettings?.isValid && !isDryRun && (
            <div className="flex items-start gap-2.5 rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-3">
              <AlertTriangle className="h-4 w-4 text-yellow-400 shrink-0 mt-0.5" />
              <div className="text-xs text-yellow-300">
                <p className="font-medium">No valid bot token</p>
                <p className="text-yellow-300/70 mt-0.5">
                  <Link href="/bot-token"><span className="underline cursor-pointer">Configure your bot token</span></Link> or enable Dry-run mode to test.
                </p>
              </div>
            </div>
          )}

          {isDryRun && (
            <div className="flex items-start gap-2.5 rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-3">
              <FlaskConical className="h-4 w-4 text-yellow-400 shrink-0 mt-0.5" />
              <p className="text-xs text-yellow-300">
                <span className="font-medium">Dry-run mode active.</span> No real messages will be sent. This is for testing only.
              </p>
            </div>
          )}

          {/* Launch Button */}
          <button
            onClick={handleLaunch}
            disabled={!selectedListId || !message.trim() || createMutation.isPending || launchMutation.isPending}
            className="w-full flex items-center justify-center gap-2 rounded-xl gradient-primary px-4 py-3 text-sm font-semibold text-white disabled:opacity-50 disabled:cursor-not-allowed hover:opacity-90 transition-opacity glow-primary"
          >
            {createMutation.isPending || launchMutation.isPending ? (
              <><Loader2 className="h-4 w-4 animate-spin" />Preparing…</>
            ) : isDryRun ? (
              <><Zap className="h-4 w-4" />Launch Dry Run</>
            ) : (
              <><Rocket className="h-4 w-4" />Launch Broadcast</>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
