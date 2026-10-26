import { useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import MessagePreview from "@/components/MessagePreview";
import StatusBadge from "@/components/StatusBadge";
import type { ParseMode } from "@/hooks/useServerDraft";
import {
  Bot,
  Clock,
  Zap,
  Plus,
  Trash2,
  Loader2,
  CheckCircle2,
  AlertTriangle,
} from "lucide-react";
import { toast } from "sonner";
const selectClass =
  "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm";
export default function Autopilot() {
  const rules = trpc.automation.list.useQuery(undefined, {
    refetchInterval: 5000,
  });
  const events = trpc.automation.events.useQuery(
    { limit: 30 },
    { refetchInterval: 5000 }
  );
  const operations = trpc.operations.status.useQuery(undefined, {
    refetchInterval: 5000,
  });
  const lists = trpc.recipients.list.useQuery();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"bot" | "mtproto">("bot");
  const [listId, setListId] = useState("");
  const [message, setMessage] = useState("");
  const [parseMode, setParseMode] = useState<ParseMode>("HTML");
  const [trigger, setTrigger] = useState<"schedule" | "webhook">("schedule");
  const [interval, setInterval] = useState(1440);
  const [dryRun, setDryRun] = useState(true);
  const [useCurrentAudience, setUseCurrentAudience] = useState(false);
  const [approved, setApproved] = useState(false);
  const [maxRuns, setMaxRuns] = useState(1);
  const [secret, setSecret] = useState("");
  const [webhookPath, setWebhookPath] = useState("");
  const pendingRequest = useRef<{ key: string; fingerprint: string } | null>(
    null
  );
  const resume = trpc.operations.resumeSender.useMutation({
    onSuccess: () => {
      toast.success("Состояние отправителя обновлено");
      void operations.refetch();
    },
    onError: error => toast.error(error.message),
  });
  const create = trpc.automation.create.useMutation({
    onSuccess: data => {
      setSecret(data.webhookSecret ?? "");
      setWebhookPath(data.webhookPath ?? "");
      pendingRequest.current = null;
      try {
        localStorage.removeItem("tg-sender:automation-create");
      } catch {}
      setShowForm(false);
      setApproved(false);
      toast.success("Сценарий создан");
      void rules.refetch();
    },
    onError: error => toast.error(error.message),
  });
  const toggle = trpc.automation.updateEnabled.useMutation({
    onSuccess: () => void rules.refetch(),
    onError: error => toast.error(error.message),
  });
  const remove = trpc.automation.remove.useMutation({
    onSuccess: () => void rules.refetch(),
    onError: error => toast.error(error.message),
  });
  const health = operations.data;
  function createRule() {
    const payload = {
      name,
      transport,
      listId: Number(listId),
      message,
      parseMode,
      trigger,
      intervalMinutes: trigger === "schedule" ? interval : undefined,
      approved: true as const,
      isDryRun: dryRun,
      maxRunsPerDay: maxRuns,
      useCurrentAudience,
    };
    const fingerprint = JSON.stringify(payload);
    let request = pendingRequest.current;
    try {
      if (!request)
        request = JSON.parse(
          localStorage.getItem("tg-sender:automation-create") ?? "null"
        );
    } catch {}
    if (!request || request.fingerprint !== fingerprint)
      request = { key: crypto.randomUUID(), fingerprint };
    pendingRequest.current = request;
    try {
      localStorage.setItem(
        "tg-sender:automation-create",
        JSON.stringify(request)
      );
    } catch {}
    create.mutate({ ...payload, requestKey: request.key });
  }
  return (
    <div className="p-5 lg:p-8 max-w-6xl mx-auto space-y-6">
      <div className="flex flex-wrap justify-between items-start gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Zap className="h-6 w-6 text-primary" />
            <h1 className="text-2xl font-bold">Автопилот</h1>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            Один раз утверждаете текст и аудиторию. Дальше система работает по
            заданным правилам.
          </p>
        </div>
        <Button onClick={() => setShowForm(!showForm)}>
          <Plus className="h-4 w-4" />
          Новый сценарий
        </Button>
      </div>
      {health && !health.liveSendEnabled && (
        <p className="rounded-xl border border-border bg-muted/20 p-4 text-sm">
          Сервис работает в режиме проверки. Реальные отправки выключены в
          настройке сервера.
        </p>
      )}
      {operations.error && (
        <p role="alert" className="text-sm text-red-400">
          {operations.error.message}
        </p>
      )}
      <div className="grid sm:grid-cols-3 gap-3">
        {[
          {
            label: "База данных",
            ok: health?.database,
            text: health?.database ? "Доступна" : "Нет подтверждения",
          },
          {
            label: "Обработчик очереди",
            ok: health?.worker.running,
            text: health?.worker.running ? "Активен" : "Нет свежего сигнала",
          },
          {
            label: "Готовность сервиса",
            ok: health?.ready,
            text: health?.ready ? "Готов" : "Требуется настройка",
          },
        ].map(item => (
          <div
            key={item.label}
            className="rounded-xl border border-border bg-card p-4"
          >
            <p className="text-xs text-muted-foreground">{item.label}</p>
            <p className="text-sm font-medium flex items-center gap-2 mt-2">
              {item.ok ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-400" />
              ) : (
                <AlertTriangle className="h-4 w-4 text-amber-400" />
              )}
              {operations.isLoading ? "Проверяем…" : item.text}
            </p>
          </div>
        ))}
      </div>
      {!!health?.exceptions.length && (
        <section className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-5 space-y-3">
          <h2 className="text-sm font-semibold">Нужно ваше действие</h2>
          {health.exceptions.map(item => (
            <div key={item.id} className="text-sm">
              <p className="font-medium">{item.title}</p>
              {item.detail && (
                <p className="text-xs text-muted-foreground mt-1">
                  {item.detail}
                </p>
              )}
            </div>
          ))}
        </section>
      )}
      {!!health?.senders.length && (
        <section className="flex flex-wrap gap-3">
          {health.senders.map(sender => (
            <div
              key={sender.transport}
              className="rounded-xl border border-border bg-card p-4 space-y-2"
            >
              <p className="text-sm font-medium">
                {sender.transport === "bot"
                  ? "Очередь бота"
                  : "Очередь аккаунта"}
              </p>
              <StatusBadge status={sender.state} />
              <p className="text-xs text-muted-foreground max-w-xs">
                Подключение к Telegram проверяется при реальном запуске.
              </p>
              {sender.cooldownUntil && (
                <p className="text-xs text-muted-foreground">
                  Продолжение после{" "}
                  {new Date(sender.cooldownUntil).toLocaleString("ru-RU")}
                </p>
              )}
              {sender.reason && (
                <p className="text-xs text-muted-foreground max-w-sm">
                  {sender.reason}
                </p>
              )}
              {sender.state === "REVIEW_REQUIRED" && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={resume.isPending}
                  onClick={() => {
                    if (
                      confirm(
                        "Подтверждаете, что проверили ограничение в Telegram и причина остановки устранена?"
                      )
                    )
                      resume.mutate({
                        transport: sender.transport,
                        confirmed: true,
                      });
                  }}
                >
                  Проверено — возобновить
                </Button>
              )}
            </div>
          ))}
        </section>
      )}
      {secret && (
        <section className="rounded-xl border border-primary/30 bg-primary/5 p-5 space-y-3">
          <h2 className="text-sm font-semibold">Секрет подключения webhook</h2>
          <p className="text-xs text-muted-foreground">
            Показывается один раз. Передайте его в защищённую настройку вашей
            CRM. В истории и отчётах он не сохраняется.
          </p>
          <p className="text-xs break-all">
            <strong>POST</strong> {window.location.origin}
            {webhookPath}
          </p>
          <p className="text-xs text-muted-foreground">
            Заголовок: Authorization: Bearer [секрет]. Тело:{" "}
            <code>{JSON.stringify({ eventId: "unique-crm-event-id" })}</code>
          </p>
          <input
            aria-label="Секрет webhook"
            readOnly
            type="password"
            className="w-full rounded-lg bg-background border border-border p-3 font-mono text-xs"
            value={secret}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(secret);
                  toast.success("Секрет скопирован");
                } catch {
                  toast.error("Не удалось скопировать");
                }
              }}
            >
              Скопировать
            </Button>
            <Button size="sm" variant="outline" onClick={() => setSecret("")}>
              Скрыть
            </Button>
          </div>
        </section>
      )}
      {showForm && (
        <section className="rounded-xl border border-border bg-card p-5 space-y-5">
          <h2 className="font-semibold">Настройка сценария</h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <label className="text-sm space-y-2">
              <span>Название</span>
              <Input
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="Еженедельная сводка"
              />
            </label>
            <label className="text-sm space-y-2">
              <span>Отправитель</span>
              <select
                className={selectClass}
                value={transport}
                onChange={e => {
                  setTransport(e.target.value as "bot" | "mtproto");
                  setApproved(false);
                }}
              >
                <option value="bot">Бот</option>
                <option value="mtproto">Личный аккаунт</option>
              </select>
            </label>
            <label className="text-sm space-y-2">
              <span>Аудитория</span>
              <select
                className={selectClass}
                value={listId}
                onChange={e => {
                  setListId(e.target.value);
                  setApproved(false);
                }}
              >
                <option value="">Выберите список</option>
                {lists.data?.map(list => (
                  <option key={list.id} value={list.id}>
                    {list.name} · {list.totalCount}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm space-y-2">
              <span>Запуск</span>
              <select
                className={selectClass}
                value={trigger}
                onChange={e => {
                  setTrigger(e.target.value as "schedule" | "webhook");
                  setApproved(false);
                }}
              >
                <option value="schedule">По расписанию</option>
                <option value="webhook">Событие из CRM / webhook</option>
              </select>
            </label>
            {trigger === "schedule" && (
              <label className="text-sm space-y-2">
                <span>Интервал, минут</span>
                <Input
                  type="number"
                  min={5}
                  max={525600}
                  value={interval}
                  onChange={e => {
                    setInterval(Number(e.target.value));
                    setApproved(false);
                  }}
                />
              </label>
            )}
            <label className="text-sm space-y-2">
              <span>Максимум запусков в день</span>
              <Input
                type="number"
                min={1}
                max={100}
                value={maxRuns}
                onChange={e => {
                  setMaxRuns(Number(e.target.value));
                  setApproved(false);
                }}
              />
            </label>
          </div>
          <div className="grid lg:grid-cols-2 gap-5">
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <label
                  htmlFor="automation-message"
                  className="text-sm font-medium"
                >
                  Утверждаемый текст
                </label>
                <select
                  aria-label="Формат сообщения сценария"
                  className="rounded border border-border bg-background p-2 text-xs"
                  value={parseMode}
                  onChange={e => {
                    setParseMode(e.target.value as ParseMode);
                    setApproved(false);
                  }}
                >
                  <option value="HTML">HTML</option>
                  <option value="Markdown">Markdown</option>
                  <option value="None">Обычный текст</option>
                </select>
              </div>
              <textarea
                id="automation-message"
                className="w-full rounded-lg border border-border bg-background p-3 min-h-52 text-sm"
                value={message}
                onChange={e => {
                  setMessage(e.target.value);
                  setApproved(false);
                }}
              />
            </div>
            <MessagePreview message={message} parseMode={parseMode} />
          </div>
          <p className="text-xs text-muted-foreground">
            Повторное событие с тем же eventId не создаёт повторную кампанию.
            Webhook запускает утверждённый текст. Аудитория берётся из снимка
            или обновляемого списка по выбранному ниже правилу. Реальные
            отправки доступны после настройки сервера и отправителя.
          </p>
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={useCurrentAudience}
              onChange={event => {
                setUseCurrentAudience(event.target.checked);
                setApproved(false);
              }}
            />
            <span>
              Использовать актуальный состав списка для будущих запусков.
              <span className="block text-xs text-muted-foreground mt-1">
                Новые подписчики из подключённого источника смогут попадать в
                следующие кампании автоматически. Уже созданные кампании
                сохраняют свой снимок; отписки действуют всегда. Если выключено,
                сохраняется состав на момент утверждения.
              </span>
            </span>
          </label>
          <label className="flex items-center gap-3 text-sm">
            <input
              type="checkbox"
              checked={dryRun}
              onChange={e => {
                setDryRun(e.target.checked);
                setApproved(false);
              }}
            />
            Проверка без отправки
          </label>
          <label className="flex items-start gap-3 text-sm">
            <input
              className="mt-1"
              type="checkbox"
              checked={approved}
              onChange={e => setApproved(e.target.checked)}
            />
            <span>
              Утверждаю этот текст, аудиторию и правило повторных запусков.{" "}
              {dryRun
                ? "Сообщения не отправляются."
                : "Разрешаю реальные отправки без повторного согласования."}
            </span>
          </label>
          <Button
            disabled={
              create.isPending ||
              !name.trim() ||
              !message.trim() ||
              message.length > 4096 ||
              !listId ||
              !approved ||
              !Number.isInteger(maxRuns) ||
              maxRuns < 1 ||
              maxRuns > 100 ||
              (trigger === "schedule" &&
                (!Number.isInteger(interval) || interval < 5))
            }
            onClick={createRule}
          >
            {create.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Zap className="h-4 w-4" />
            )}
            Создать утверждённый сценарий
          </Button>
        </section>
      )}
      <section className="space-y-3">
        <h2 className="font-semibold">Ваши сценарии</h2>
        {rules.error && (
          <p role="alert" className="text-sm text-red-400">
            {rules.error.message}
          </p>
        )}
        {rules.isLoading ? (
          <p className="text-sm text-muted-foreground">Загружаем…</p>
        ) : !rules.data?.length ? (
          <div className="rounded-xl border border-border bg-card p-8 text-center">
            <Bot className="h-8 w-8 mx-auto text-primary mb-3" />
            <p className="text-sm font-medium">
              Пока всё под вашим управлением
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Создайте первый сценарий, чтобы повторяющиеся задачи выполнялись
              сами.
            </p>
          </div>
        ) : (
          rules.data.map(rule => (
            <article
              key={rule.id}
              className="rounded-xl border border-border bg-card p-4 flex flex-wrap items-center gap-4"
            >
              <div className="flex-1 min-w-48">
                <p className="font-medium text-sm">{rule.name}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {rule.transport === "bot" ? "Бот" : "Аккаунт"} ·{" "}
                  {rule.trigger === "schedule"
                    ? `Каждые ${rule.intervalMinutes} мин`
                    : "Webhook"}{" "}
                  · {rule.isDryRun ? "Без отправки" : "Реальные сообщения"}
                </p>
                {!rule.enabled && (
                  <p className="text-xs text-amber-400 mt-1">Приостановлен</p>
                )}
                {rule.enabled && rule.nextRunAt && (
                  <p className="text-xs text-muted-foreground mt-1">
                    <Clock className="h-3 w-3 inline mr-1" />
                    Следующий запуск:{" "}
                    {new Date(rule.nextRunAt).toLocaleString("ru-RU")}
                  </p>
                )}
              </div>
              <Button
                size="sm"
                variant={rule.enabled ? "outline" : "default"}
                disabled={toggle.isPending}
                onClick={() =>
                  toggle.mutate({ id: rule.id, enabled: !rule.enabled })
                }
              >
                {rule.enabled ? "Приостановить" : "Включить"}
              </Button>
              <Button
                aria-label="Удалить сценарий"
                size="icon"
                variant="ghost"
                disabled={remove.isPending}
                onClick={() => {
                  if (confirm(`Удалить сценарий «${rule.name}»?`))
                    remove.mutate({ id: rule.id });
                }}
              >
                <Trash2 className="h-4 w-4 text-red-400" />
              </Button>
            </article>
          ))
        )}
      </section>
      <section className="space-y-3">
        <h2 className="font-semibold">Последние события</h2>
        {events.error && (
          <p role="alert" className="text-sm text-red-400">
            {events.error.message}
          </p>
        )}
        {!events.data?.length ? (
          <p className="text-sm text-muted-foreground">
            Здесь появятся результаты запусков. Обычные ожидания система
            обрабатывает сама.
          </p>
        ) : (
          <div className="rounded-xl border border-border divide-y divide-border">
            {events.data.map(event => (
              <div
                key={event.id}
                className="p-3 flex flex-wrap gap-3 items-center text-xs"
              >
                <StatusBadge status={event.status} />
                <span className="flex-1 min-w-40">
                  {event.detail ?? `Сценарий #${event.ruleId}`}
                </span>
                <time className="text-muted-foreground">
                  {new Date(event.createdAt).toLocaleString("ru-RU")}
                </time>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
