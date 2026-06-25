import { useState, useEffect, useRef } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import { useLocation } from "wouter";
import {
  Rocket, Users, MessageSquare, Timer, CheckCircle2, XCircle,
  Loader2, AlertTriangle, User, Play, Square, Download, Eye,
  ChevronDown, ChevronUp, FlaskConical,
} from "lucide-react";

type ParseMode = "HTML" | "Markdown" | "MarkdownV2" | "None";

export default function UserBroadcast() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();

  // Form state
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [parseMode, setParseMode] = useState<ParseMode>("HTML");
  const [delaySeconds, setDelaySeconds] = useState(3);
  const [isDryRun, setIsDryRun] = useState(false);
  const [recipientListId, setRecipientListId] = useState<number | null>(null);

  // Active broadcast tracking
  const [activeBroadcastId, setActiveBroadcastId] = useState<number | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { data: session } = trpc.mtproto.getSession.useQuery();
  const { data: recipientLists } = trpc.recipients.list.useQuery();
  const { data: broadcasts, refetch: refetchBroadcasts } = trpc.mtproto.listBroadcasts.useQuery();

  const { data: progress } = trpc.mtproto.getProgress.useQuery(
    { id: activeBroadcastId! },
    { enabled: !!activeBroadcastId, refetchInterval: activeBroadcastId ? 1500 : false }
  );

  const createMutation = trpc.mtproto.createBroadcast.useMutation({
    onSuccess: async (bc) => {
      if (!bc) return;
      setActiveBroadcastId(bc.id);
      launchMutation.mutate({ id: bc.id });
    },
    onError: (e) => toast.error(`Ошибка создания: ${e.message}`),
  });

  const launchMutation = trpc.mtproto.launchBroadcast.useMutation({
    onSuccess: () => {
      toast.success("Рассылка запущена!");
      refetchBroadcasts();
    },
    onError: (e) => toast.error(`Ошибка запуска: ${e.message}`),
  });

  const cancelMutation = trpc.mtproto.cancelBroadcast.useMutation({
    onSuccess: () => {
      toast.info("Рассылка остановлена");
      setActiveBroadcastId(null);
      refetchBroadcasts();
    },
    onError: (e) => toast.error(`Ошибка: ${e.message}`),
  });

  // Stop polling when broadcast finishes
  useEffect(() => {
    if (progress && !progress.running && activeBroadcastId) {
      if (progress.status === "completed") {
        toast.success(`Рассылка завершена! Отправлено: ${progress.sent}, Ошибок: ${progress.failed}`);
      } else if (progress.status === "failed") {
        toast.error("Рассылка завершилась с ошибкой");
      }
      setActiveBroadcastId(null);
      refetchBroadcasts();
      utils.stats.dashboard.invalidate();
    }
  }, [progress, activeBroadcastId]);

  const isConnected = session?.isActive;
  const selectedList = recipientLists?.find((l) => l.id === recipientListId);
  const isRunning = !!(progress?.running && activeBroadcastId);
  const progressPct = progress && progress.total > 0
    ? Math.round(((progress.sent + progress.failed) / progress.total) * 100)
    : 0;

  const handleLaunch = () => {
    if (!recipientListId) return toast.error("Выберите список получателей");
    if (!message.trim()) return toast.error("Введите текст сообщения");
    if (!name.trim()) return toast.error("Введите название рассылки");
    createMutation.mutate({ name, message, parseMode, delaySeconds, isDryRun, recipientListId });
  };

  const estimatedTime = selectedList
    ? Math.round((selectedList.totalCount * delaySeconds) / 60)
    : 0;

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">User Account Broadcast</h1>
        <p className="text-muted-foreground mt-1">
          Рассылка от вашего личного Telegram-аккаунта по любым пользователям
        </p>
      </div>

      {/* Account status */}
      {!isConnected ? (
        <div className="flex items-center gap-3 rounded-lg border border-red-500/30 bg-red-500/10 p-4">
          <AlertTriangle className="h-5 w-5 text-red-400 shrink-0" />
          <div className="flex-1">
            <p className="text-sm font-medium text-red-300">Аккаунт не подключён</p>
            <p className="text-xs text-red-400/70 mt-0.5">Для запуска рассылки необходимо подключить Telegram-аккаунт</p>
          </div>
          <Button size="sm" variant="outline" className="border-red-500/30 text-red-300 hover:bg-red-500/10"
            onClick={() => navigate("/user-account")}>
            <User className="h-4 w-4 mr-1" /> Подключить
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3">
          <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
          <p className="text-sm text-emerald-300">
            Аккаунт подключён: <span className="font-semibold">
              {[session.firstName, session.lastName].filter(Boolean).join(" ") || session.phone}
            </span>
            {session.username && <span className="text-emerald-400/70 ml-1">(@{session.username})</span>}
          </p>
        </div>
      )}

      {/* Active broadcast progress */}
      {isRunning && progress && (
        <Card className="border-primary/30 bg-primary/5">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
                Рассылка выполняется...
              </CardTitle>
              <Button
                size="sm"
                variant="outline"
                className="border-red-500/30 text-red-400 hover:bg-red-500/10"
                onClick={() => activeBroadcastId && cancelMutation.mutate({ id: activeBroadcastId })}
                disabled={cancelMutation.isPending}
              >
                <Square className="h-3 w-3 mr-1" /> Остановить
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <Progress value={progressPct} className="h-2" />
            <div className="grid grid-cols-4 gap-3 text-center">
              <StatBox label="Прогресс" value={`${progressPct}%`} color="text-primary" />
              <StatBox label="Отправлено" value={progress.sent} color="text-emerald-400" />
              <StatBox label="Ошибок" value={progress.failed} color="text-red-400" />
              <StatBox label="Осталось" value={Math.max(0, progress.total - progress.sent - progress.failed)} color="text-muted-foreground" />
            </div>
          </CardContent>
        </Card>
      )}

      {/* Config form */}
      <div className="grid gap-5">
        {/* Name */}
        <Card className="border-border/50 bg-card/50">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <MessageSquare className="h-4 w-4 text-primary" /> Название рассылки
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Input
              placeholder="Например: Акция июнь 2026"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="bg-background/50 border-border/60"
            />
          </CardContent>
        </Card>

        {/* Recipient list */}
        <Card className="border-border/50 bg-card/50">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Users className="h-4 w-4 text-primary" /> Список получателей
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {recipientLists && recipientLists.length > 0 ? (
              <Select
                value={recipientListId?.toString() ?? ""}
                onValueChange={(v) => setRecipientListId(Number(v))}
              >
                <SelectTrigger className="bg-background/50 border-border/60">
                  <SelectValue placeholder="Выберите список..." />
                </SelectTrigger>
                <SelectContent>
                  {recipientLists.map((list) => (
                    <SelectItem key={list.id} value={list.id.toString()}>
                      <span className="flex items-center gap-2">
                        {list.name}
                        <Badge variant="outline" className="text-xs">{list.totalCount} ID</Badge>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <div className="text-sm text-muted-foreground flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-400" />
                Нет загруженных списков.{" "}
                <button className="text-primary underline" onClick={() => navigate("/recipients")}>
                  Загрузить список
                </button>
              </div>
            )}
            {selectedList && (
              <p className="text-xs text-muted-foreground">
                {selectedList.totalCount} получателей · Формат: {selectedList.fileType.toUpperCase()}
                {estimatedTime > 0 && ` · Примерное время: ~${estimatedTime} мин`}
              </p>
            )}
          </CardContent>
        </Card>

        {/* Message */}
        <Card className="border-border/50 bg-card/50">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <MessageSquare className="h-4 w-4 text-primary" /> Текст сообщения
              </CardTitle>
              <Select value={parseMode} onValueChange={(v) => setParseMode(v as ParseMode)}>
                <SelectTrigger className="w-36 h-7 text-xs bg-background/50 border-border/60">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="HTML">HTML</SelectItem>
                  <SelectItem value="Markdown">Markdown</SelectItem>
                  <SelectItem value="MarkdownV2">MarkdownV2</SelectItem>
                  <SelectItem value="None">Без форматирования</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            <Textarea
              placeholder="Введите текст сообщения..."
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={5}
              className="bg-background/50 border-border/60 resize-none font-mono text-sm"
            />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>{message.length} символов</span>
              {message.length > 4096 && (
                <span className="text-red-400">Превышен лимит Telegram (4096 символов)</span>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Settings */}
        <Card className="border-border/50 bg-card/50">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Timer className="h-4 w-4 text-primary" /> Настройки отправки
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            {/* Delay slider */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-sm text-foreground">Задержка между отправками</label>
                <span className="text-sm font-mono font-semibold text-primary">{delaySeconds} сек</span>
              </div>
              <Slider
                min={1}
                max={30}
                step={0.5}
                value={[delaySeconds]}
                onValueChange={([v]) => setDelaySeconds(v)}
                className="w-full"
              />
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>1 сек (быстро)</span>
                <span className="text-amber-400">Рекомендуется: 3–5 сек</span>
                <span>30 сек (безопасно)</span>
              </div>
            </div>

            <Separator className="bg-border/50" />

            {/* Dry-run toggle */}
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <FlaskConical className="h-4 w-4 text-amber-400" />
                  Dry-run mode
                </div>
                <p className="text-xs text-muted-foreground">
                  Симуляция без реальной отправки — для тестирования
                </p>
              </div>
              <Switch checked={isDryRun} onCheckedChange={setIsDryRun} />
            </div>
          </CardContent>
        </Card>

        {/* Launch button */}
        <Button
          size="lg"
          className="w-full h-12 text-base font-semibold"
          onClick={handleLaunch}
          disabled={!isConnected || isRunning || createMutation.isPending || launchMutation.isPending || message.length > 4096}
        >
          {createMutation.isPending || launchMutation.isPending ? (
            <><Loader2 className="h-5 w-5 mr-2 animate-spin" /> Запуск...</>
          ) : isDryRun ? (
            <><FlaskConical className="h-5 w-5 mr-2" /> Запустить тест (Dry-run)</>
          ) : (
            <><Rocket className="h-5 w-5 mr-2" /> Запустить рассылку</>
          )}
        </Button>
      </div>

      {/* History */}
      {broadcasts && broadcasts.length > 0 && (
        <Card className="border-border/50 bg-card/50">
          <CardHeader className="pb-3 cursor-pointer" onClick={() => setShowHistory(!showHistory)}>
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                История рассылок через аккаунт
                <Badge variant="outline" className="text-xs">{broadcasts.length}</Badge>
              </CardTitle>
              {showHistory ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
            </div>
          </CardHeader>
          {showHistory && (
            <CardContent>
              <div className="space-y-2">
                {broadcasts.slice(0, 10).map((bc) => (
                  <div key={bc.id} className="flex items-center justify-between rounded-lg border border-border/40 bg-background/30 px-3 py-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">{bc.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(bc.createdAt).toLocaleString("ru-RU")} · {bc.totalRecipients} получателей
                      </p>
                    </div>
                    <div className="flex items-center gap-2 ml-3">
                      <StatusBadge status={bc.status} />
                      {bc.status === "completed" && (
                        <span className="text-xs text-emerald-400 font-mono">
                          {bc.successRate?.toFixed(0)}%
                        </span>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-muted-foreground hover:text-foreground"
                        onClick={() => navigate(`/user-broadcast-report/${bc.id}`)}
                      >
                        <Eye className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          )}
        </Card>
      )}
    </div>
  );
}

function StatBox({ label, value, color }: { label: string; value: string | number; color: string }) {
  return (
    <div className="rounded-lg border border-border/40 bg-background/30 p-2">
      <p className={`text-lg font-bold font-mono ${color}`}>{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    pending:   { label: "Ожидание", cls: "bg-muted/50 text-muted-foreground" },
    running:   { label: "Выполняется", cls: "bg-blue-500/20 text-blue-400 border-blue-500/30" },
    completed: { label: "Завершено", cls: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30" },
    failed:    { label: "Ошибка", cls: "bg-red-500/20 text-red-400 border-red-500/30" },
    cancelled: { label: "Отменено", cls: "bg-amber-500/20 text-amber-400 border-amber-500/30" },
  };
  const s = map[status] ?? map.pending;
  return <Badge className={`text-xs border ${s.cls}`}>{s.label}</Badge>;
}
