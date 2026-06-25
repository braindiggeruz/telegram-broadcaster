import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { getLoginUrl } from "@/const";
import {
  Bot, CheckCircle2, XCircle, Eye, EyeOff, Loader2, Shield, ArrowRight, RefreshCw, Info
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export default function BotToken() {
  const { isAuthenticated, loading: authLoading } = useAuth();
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);

  const { data: botSettings, isLoading, refetch } = trpc.bot.get.useQuery(undefined, {
    enabled: isAuthenticated,
  });

  const validateMutation = trpc.bot.validate.useMutation({
    onSuccess: (data) => {
      if (data.valid) {
        toast.success(`Bot validated! @${data.botUsername} — ${data.botName}`);
        refetch();
        setToken("");
      } else {
        toast.error(`Invalid token: ${data.error}`);
      }
    },
    onError: (err) => toast.error(err.message),
  });

  if (authLoading) return <div className="flex h-full items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>;

  if (!isAuthenticated) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        <p className="text-muted-foreground">Please sign in to manage your bot token.</p>
        <a href={getLoginUrl()} className="inline-flex items-center gap-2 rounded-xl gradient-primary px-5 py-2.5 text-sm font-semibold text-white">
          Sign in <ArrowRight className="h-4 w-4" />
        </a>
      </div>
    );
  }

  const isValid = botSettings?.isValid;
  const hasToken = !!botSettings;

  return (
    <div className="p-6 lg:p-8 max-w-2xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">Bot Token</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Configure and validate your Telegram bot token to enable broadcasting.</p>
      </div>

      {/* Current Status Card */}
      <div className={cn(
        "rounded-xl border p-5 transition-all duration-300",
        isLoading ? "border-border bg-card" :
        !hasToken ? "border-border bg-card" :
        isValid ? "border-emerald-500/30 bg-emerald-500/5" : "border-red-500/30 bg-red-500/5"
      )}>
        <div className="flex items-center gap-4">
          <div className={cn(
            "flex h-12 w-12 items-center justify-center rounded-xl shrink-0",
            isLoading ? "bg-muted" :
            !hasToken ? "bg-muted" :
            isValid ? "bg-emerald-500/15" : "bg-red-500/15"
          )}>
            {isLoading ? (
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            ) : !hasToken ? (
              <Bot className="h-5 w-5 text-muted-foreground" />
            ) : isValid ? (
              <CheckCircle2 className="h-5 w-5 text-emerald-400" />
            ) : (
              <XCircle className="h-5 w-5 text-red-400" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            {isLoading ? (
              <div className="space-y-2">
                <div className="h-4 w-32 bg-muted rounded animate-pulse" />
                <div className="h-3 w-48 bg-muted rounded animate-pulse" />
              </div>
            ) : !hasToken ? (
              <>
                <p className="text-sm font-semibold text-foreground">No token configured</p>
                <p className="text-xs text-muted-foreground mt-0.5">Enter your bot token below to get started.</p>
              </>
            ) : isValid ? (
              <>
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold text-foreground">{botSettings.botName}</p>
                  <span className="badge-success"><CheckCircle2 className="h-3 w-3" />Valid</span>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  @{botSettings.botUsername} · Validated {botSettings.validatedAt ? new Date(botSettings.validatedAt).toLocaleDateString() : "—"}
                </p>
              </>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold text-foreground">Invalid Token</p>
                  <span className="badge-failed"><XCircle className="h-3 w-3" />Invalid</span>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">The saved token failed validation. Please update it.</p>
              </>
            )}
          </div>
          {hasToken && !isLoading && (
            <button
              onClick={() => refetch()}
              className="rounded-lg p-2 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              title="Refresh status"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
          )}
        </div>

        {hasToken && botSettings && (
          <div className="mt-4 pt-4 border-t border-border/50">
            <p className="text-xs text-muted-foreground mb-1.5">Saved Token</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded-lg bg-muted px-3 py-2 text-xs font-mono text-muted-foreground truncate">
                {showToken ? botSettings.botToken : `${botSettings.botToken.slice(0, 10)}${"•".repeat(20)}`}
              </code>
              <button
                onClick={() => setShowToken(!showToken)}
                className="rounded-lg p-2 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              >
                {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Token Input Form */}
      <div className="rounded-xl border border-border bg-card p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Shield className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold text-foreground">{hasToken ? "Update Token" : "Enter Bot Token"}</h2>
        </div>

        <div className="space-y-2">
          <label className="text-xs font-medium text-muted-foreground">Bot Token</label>
          <div className="relative">
            <input
              type={showToken ? "text" : "password"}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="1234567890:ABCdefGHIjklMNOpqrsTUVwxyz"
              className="w-full rounded-lg border border-border bg-input px-4 py-2.5 pr-10 text-sm font-mono text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/60 transition-all"
            />
            <button
              type="button"
              onClick={() => setShowToken(!showToken)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>

        <button
          onClick={() => validateMutation.mutate({ token })}
          disabled={!token.trim() || validateMutation.isPending}
          className="w-full flex items-center justify-center gap-2 rounded-lg gradient-primary px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50 disabled:cursor-not-allowed hover:opacity-90 transition-opacity"
        >
          {validateMutation.isPending ? (
            <><Loader2 className="h-4 w-4 animate-spin" />Validating…</>
          ) : (
            <><CheckCircle2 className="h-4 w-4" />{hasToken ? "Update & Validate" : "Validate Token"}</>
          )}
        </button>
      </div>

      {/* Help */}
      <div className="rounded-xl border border-border/50 bg-muted/20 p-4 flex gap-3">
        <Info className="h-4 w-4 text-primary shrink-0 mt-0.5" />
        <div className="text-xs text-muted-foreground space-y-1">
          <p className="font-medium text-foreground">How to get a bot token</p>
          <p>1. Open Telegram and search for <span className="font-mono text-primary">@BotFather</span></p>
          <p>2. Send <span className="font-mono text-primary">/newbot</span> and follow the instructions</p>
          <p>3. Copy the token provided and paste it above</p>
          <p className="pt-1">Keep your token secret — it grants full control of your bot.</p>
        </div>
      </div>
    </div>
  );
}
