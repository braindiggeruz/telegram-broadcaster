import { useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { useServerDraft, type ParseMode } from "@/hooks/useServerDraft";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import MessagePreview from "@/components/MessagePreview";
import StatusBadge, { terminalStatuses } from "@/components/StatusBadge";
import { Loader2, Play, Square, ArrowRight, FlaskConical } from "lucide-react";
import { toast } from "sonner";

const selectClass =
  "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm";
function initialId(transport: string) {
  const query = new URLSearchParams(window.location.search).get("campaign");
  let value = query;
  try {
    value ??= localStorage.getItem(`tg-sender:active:${transport}`);
  } catch {}
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}
export default function CampaignForm({
  transport,
}: {
  transport: "bot" | "mtproto";
}) {
  const [, navigate] = useLocation();
  const draft = useServerDraft(transport);
  const [name, setName] = useState(
    `Рассылка ${new Date().toLocaleDateString("ru-RU")}`
  );
  const [listId, setListId] = useState("");
  const [delay, setDelay] = useState(transport === "bot" ? 1 : 3);
  const [dryRun, setDryRun] = useState(true);
  const [approved, setApproved] = useState(false);
  const [activeId, setActiveId] = useState<number | null>(() =>
    initialId(transport)
  );
  const [launching, setLaunching] = useState(false);
  const pendingKey = useRef<{ fingerprint: string; key: string } | null>(null);
  const lists = trpc.recipients.list.useQuery();
  const bot = trpc.bot.get.useQuery(undefined, {
    enabled: transport === "bot",
  });
  const account = trpc.mtproto.getSession.useQuery(undefined, {
    enabled: transport === "mtproto",
  });
  const botProgress = trpc.broadcast.getProgress.useQuery(
    { id: activeId ?? 0 },
    { enabled: transport === "bot" && !!activeId, refetchInterval: 2000 }
  );
  const accountProgress = trpc.mtproto.getProgress.useQuery(
    { id: activeId ?? 0 },
    { enabled: transport === "mtproto" && !!activeId, refetchInterval: 2000 }
  );
  const botCreate = trpc.broadcast.create.useMutation();
  const accountCreate = trpc.mtproto.createBroadcast.useMutation();
  const botLaunch = trpc.broadcast.launch.useMutation();
  const accountLaunch = trpc.mtproto.launchBroadcast.useMutation();
  const botCancel = trpc.broadcast.cancel.useMutation();
  const accountCancel = trpc.mtproto.cancelBroadcast.useMutation();
  const progressQuery = transport === "bot" ? botProgress : accountProgress;
  const progress = progressQuery.data;
  const connected =
    transport === "bot" ? bot.data?.isValid : account.data?.isActive;
  const selected = lists.data?.find(list => list.id === Number(listId));
  const rootPath = transport === "bot" ? "/launch" : "/user-broadcast";
  const reportPath =
    transport === "bot"
      ? `/history/${activeId}`
      : `/user-broadcast-report/${activeId}`;
  const active =
    !!activeId && (!progress || !terminalStatuses.has(progress.status));
  const current = progress as
    | (typeof progress & {
        unknown?: number;
        suppressed?: number;
        dryRun?: number;
      })
    | undefined;
  function remember(id: number | null) {
    setActiveId(id);
    try {
      if (id) localStorage.setItem(`tg-sender:active:${transport}`, String(id));
      else localStorage.removeItem(`tg-sender:active:${transport}`);
    } catch {}
    navigate(id ? `${rootPath}?campaign=${id}` : rootPath, { replace: true });
  }
  async function launch() {
    setLaunching(true);
    try {
      const saved = await draft.saveNow();
      const payload = {
        name: name.trim(),
        message: saved.message,
        parseMode: saved.parseMode,
        delaySeconds: delay,
        isDryRun: dryRun,
        recipientListId: Number(listId),
        approved: dryRun || approved,
      };
      const fingerprint = JSON.stringify(payload);
      let request = pendingKey.current;
      try {
        if (!request)
          request = JSON.parse(
            localStorage.getItem(`tg-sender:create:${transport}`) ?? "null"
          );
      } catch {}
      if (!request || request.fingerprint !== fingerprint)
        request = { fingerprint, key: crypto.randomUUID() };
      pendingKey.current = request;
      try {
        localStorage.setItem(
          `tg-sender:create:${transport}`,
          JSON.stringify(request)
        );
      } catch {}
      const created = await (
        transport === "bot" ? botCreate : accountCreate
      ).mutateAsync({ ...payload, requestKey: request.key });
      if (!created) throw new Error("Не удалось создать кампанию");
      remember(created.id);
      pendingKey.current = null;
      try {
        localStorage.removeItem(`tg-sender:create:${transport}`);
      } catch {}
      await (transport === "bot" ? botLaunch : accountLaunch).mutateAsync({
        id: created.id,
      });
      toast.success(
        dryRun ? "Проверка добавлена в очередь" : "Кампания добавлена в очередь"
      );
      void progressQuery.refetch();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Не удалось запустить кампанию"
      );
    } finally {
      setLaunching(false);
    }
  }
  async function cancel() {
    if (!activeId) return;
    try {
      await (transport === "bot" ? botCancel : accountCancel).mutateAsync({
        id: activeId,
      });
      toast.info("Запрос остановки принят. Ожидаем подтверждение обработчика.");
      void progressQuery.refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Ошибка остановки");
    }
  }
  return (
    <div className="p-5 lg:p-8 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">
          {transport === "bot" ? "Рассылка через бота" : "Рассылка от аккаунта"}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Подготовьте кампанию один раз. Очередь, ожидания Telegram и прогресс
          сохраняются на сервере.
        </p>
      </div>
      {activeId && (
        <section
          className="rounded-xl border border-primary/30 bg-primary/5 p-5 space-y-4"
          aria-live="polite"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold">Кампания #{activeId}</p>
              <div className="mt-2">
                {progress ? (
                  <StatusBadge status={progress.status} />
                ) : (
                  <span className="text-xs text-muted-foreground">
                    Получаем состояние…
                  </span>
                )}
              </div>
            </div>
            <div className="flex gap-2">
              <Link href={reportPath}>
                <Button size="sm" variant="outline">
                  Отчёт
                  <ArrowRight className="h-3 w-3" />
                </Button>
              </Link>
              {active && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={
                    botCancel.isPending ||
                    accountCancel.isPending ||
                    progress?.status === "stopping"
                  }
                  onClick={() => void cancel()}
                >
                  <Square className="h-3 w-3" />
                  Остановить
                </Button>
              )}
            </div>
          </div>
          {progressQuery.error && (
            <p role="alert" className="text-sm text-red-400">
              {progressQuery.error.message}
            </p>
          )}
          {progress && (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                {[
                  { label: "Всего", value: progress.total },
                  { label: "Принято Telegram", value: progress.sent },
                  { label: "Ошибки", value: progress.failed },
                  { label: "Неопределённо", value: current?.unknown ?? 0 },
                  { label: "Исключено", value: current?.suppressed ?? 0 },
                  { label: "Проверено", value: current?.dryRun ?? 0 },
                ].map(item => (
                  <div
                    key={item.label}
                    className="rounded-lg bg-background/60 p-3"
                  >
                    <p className="text-lg font-semibold">{item.value}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {item.label}
                    </p>
                  </div>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                «Принято Telegram» означает успешный ответ API. Прочтение
                получателем не подтверждается. Проверка без отправки учитывается
                отдельно.
              </p>
              {progress.status === "pending" && (
                <Button
                  size="sm"
                  disabled={botLaunch.isPending || accountLaunch.isPending}
                  onClick={async () => {
                    try {
                      await (
                        transport === "bot" ? botLaunch : accountLaunch
                      ).mutateAsync({ id: activeId });
                      void progressQuery.refetch();
                    } catch (error) {
                      toast.error(
                        error instanceof Error
                          ? error.message
                          : "Ошибка запуска"
                      );
                    }
                  }}
                >
                  Повторить постановку в очередь
                </Button>
              )}
            </>
          )}
          {!active && (
            <Button size="sm" variant="outline" onClick={() => remember(null)}>
              Подготовить следующую кампанию
            </Button>
          )}
        </section>
      )}
      {!activeId && (
        <>
          {!connected && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
              Отправитель не подключён. Проверка без отправки доступна.{" "}
              <Link
                className="text-primary underline"
                href={transport === "bot" ? "/bot-token" : "/user-account"}
              >
                Подключить
              </Link>
            </div>
          )}
          <div className="grid lg:grid-cols-[1.1fr_1fr] gap-5">
            <section className="rounded-xl border border-border bg-card p-5 space-y-5">
              <label className="block space-y-2">
                <span className="text-sm font-medium">Название кампании</span>
                <Input value={name} onChange={e => setName(e.target.value)} />
              </label>
              <label className="block space-y-2">
                <span className="text-sm font-medium">Аудитория</span>
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
              {lists.error && (
                <p role="alert" className="text-sm text-red-400">
                  {lists.error.message}
                </p>
              )}
              <Link
                href="/recipients"
                className="text-xs text-primary underline"
              >
                Импортировать аудиторию
              </Link>
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <label
                    htmlFor={`campaign-message-${transport}`}
                    className="text-sm font-medium"
                  >
                    Сообщение
                  </label>
                  <select
                    className="bg-background rounded border border-border text-xs p-2"
                    aria-label="Формат сообщения"
                    value={draft.parseMode}
                    disabled={!draft.ready}
                    onChange={e => {
                      draft.setParseMode(e.target.value as ParseMode);
                      setApproved(false);
                    }}
                  >
                    <option value="HTML">HTML</option>
                    <option value="Markdown">Markdown</option>
                    <option value="None">Обычный текст</option>
                  </select>
                </div>
                <textarea
                  id={`campaign-message-${transport}`}
                  className="w-full min-h-56 rounded-lg border border-border bg-background p-3 text-sm resize-y"
                  value={draft.message}
                  disabled={!draft.ready}
                  onChange={e => {
                    draft.setMessage(e.target.value);
                    setApproved(false);
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  {draft.saving || draft.dirty
                    ? "Сохраняем черновик…"
                    : `Черновик сохранён · версия ${draft.version}`}
                </p>
                {draft.error && (
                  <div
                    role="alert"
                    className="text-sm text-amber-400 space-y-2"
                  >
                    <p>{draft.error}</p>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={draft.conflicted}
                      onClick={draft.retry}
                    >
                      Повторить сохранение
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        if (
                          confirm(
                            "Загрузить серверную версию вместо локального текста?"
                          )
                        )
                          void draft.reloadServer();
                      }}
                    >
                      Загрузить с сервера
                    </Button>
                  </div>
                )}
              </div>
              <details className="text-sm">
                <summary className="cursor-pointer text-muted-foreground">
                  Параметры отправки
                </summary>
                <label className="block mt-3 space-y-2">
                  <span className="text-xs">Минимальная пауза, секунд</span>
                  <Input
                    type="number"
                    min={transport === "bot" ? 1 : 3}
                    max={3600}
                    value={delay}
                    onChange={e => setDelay(Number(e.target.value))}
                  />
                </label>
                <p className="text-xs text-muted-foreground mt-2">
                  Общий диспетчер может увеличить паузу по требованию Telegram.
                  Задержка не гарантирует отсутствие ограничений.
                </p>
              </details>
            </section>
            <section className="rounded-xl border border-border bg-card p-5 space-y-5">
              <h2 className="text-sm font-semibold">Проверка перед запуском</h2>
              <MessagePreview
                message={draft.message}
                parseMode={draft.parseMode}
              />
              <div className="border-t border-border pt-4 space-y-3 text-sm">
                <p>
                  Отправитель:{" "}
                  <strong>
                    {transport === "bot"
                      ? bot.data?.botUsername
                        ? `@${bot.data.botUsername}`
                        : "Бот не подключён"
                      : account.data?.username
                        ? `@${account.data.username}`
                        : (account.data?.firstName ?? "Аккаунт не подключён")}
                  </strong>
                </p>
                <p>
                  Аудитория:{" "}
                  <strong>
                    {selected
                      ? `${selected.name} · ${selected.totalCount}`
                      : "Не выбрана"}
                  </strong>
                </p>
                <p className="text-xs text-muted-foreground">
                  Отписки и запреты проверяются заново перед каждой отправкой.
                </p>
              </div>
              <label className="flex gap-3 items-start rounded-lg bg-muted/30 p-3 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={dryRun}
                  onChange={e => {
                    setDryRun(e.target.checked);
                    setApproved(false);
                  }}
                />
                <span>
                  <span className="font-medium flex items-center gap-2">
                    <FlaskConical className="h-4 w-4" />
                    Проверка без отправки
                  </span>
                  <span className="block text-xs text-muted-foreground mt-1">
                    Ни одно сообщение не будет отправлено в Telegram.
                  </span>
                </span>
              </label>
              {!dryRun && (
                <label className="flex items-start gap-3 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={approved}
                    onChange={e => setApproved(e.target.checked)}
                  />
                  <span>
                    Подтверждаю этот текст, выбранную аудиторию и реальную
                    отправку.
                  </span>
                </label>
              )}
              <Button
                className="w-full"
                disabled={
                  launching ||
                  !draft.ready ||
                  !!draft.error ||
                  !name.trim() ||
                  !listId ||
                  !draft.message.trim() ||
                  draft.message.length > 4096 ||
                  !Number.isFinite(delay) ||
                  delay < (transport === "bot" ? 1 : 3) ||
                  (!dryRun && (!approved || !connected))
                }
                onClick={() => void launch()}
              >
                {launching ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Play className="h-4 w-4" />
                )}
                {dryRun
                  ? "Проверить кампанию"
                  : "Запустить утверждённую кампанию"}
              </Button>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
