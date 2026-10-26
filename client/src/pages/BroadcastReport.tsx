import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Link, useParams } from "wouter";
import { Button } from "@/components/ui/button";
import StatusBadge, { terminalStatuses } from "@/components/StatusBadge";
import MessagePreview from "@/components/MessagePreview";
import ResolveUnknown from "@/components/ResolveUnknown";
import { ArrowLeft, Download, Square } from "lucide-react";
import { toast } from "sonner";
export default function BroadcastReport({
  transport = "bot",
}: {
  transport?: "bot" | "mtproto";
}) {
  const utils = trpc.useUtils();
  const [offset, setOffset] = useState(0);
  const [exporting, setExporting] = useState(false);
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const validId = Number.isSafeInteger(id) && id > 0;
  const bot = trpc.broadcast.get.useQuery(
    { id },
    { enabled: validId && transport === "bot", refetchInterval: 3000 }
  );
  const account = trpc.mtproto.getBroadcast.useQuery(
    { id },
    { enabled: validId && transport === "mtproto", refetchInterval: 3000 }
  );
  const botLogs = trpc.broadcast.getDeliveryPage.useQuery(
    { id, offset, limit: 100 },
    { enabled: validId && transport === "bot", refetchInterval: 5000 }
  );
  const accountLogs = trpc.mtproto.getDeliveryPage.useQuery(
    { id, offset, limit: 100 },
    { enabled: validId && transport === "mtproto", refetchInterval: 5000 }
  );
  const botProgress = trpc.broadcast.getProgress.useQuery(
    { id },
    { enabled: validId && transport === "bot", refetchInterval: 3000 }
  );
  const accountProgress = trpc.mtproto.getProgress.useQuery(
    { id },
    { enabled: validId && transport === "mtproto", refetchInterval: 3000 }
  );
  const botCancel = trpc.broadcast.cancel.useMutation();
  const accountCancel = trpc.mtproto.cancelBroadcast.useMutation();
  const query = transport === "bot" ? bot : account;
  const logsQuery = transport === "bot" ? botLogs : accountLogs;
  const progress = (transport === "bot" ? botProgress : accountProgress).data;
  const bc = query.data;
  const logs = logsQuery.data?.items ?? [];
  const total = logsQuery.data?.total ?? 0;
  const status = progress?.status ?? bc?.status ?? "pending";
  if (!validId)
    return (
      <div className="p-8">
        Некорректный номер кампании.{" "}
        <Link href="/history" className="text-primary">
          К списку
        </Link>
      </div>
    );
  if (query.isLoading)
    return <div className="p-8 text-muted-foreground">Загружаем отчёт…</div>;
  if (query.error)
    return (
      <div role="alert" className="p-8 text-red-400">
        {query.error.message}
      </div>
    );
  if (!bc)
    return (
      <div className="p-8">
        Кампания не найдена.{" "}
        <Link href="/history" className="text-primary">
          К списку
        </Link>
      </div>
    );
  const additional = progress as
    | (typeof progress & {
        unknown?: number;
        suppressed?: number;
        dryRun?: number;
      })
    | undefined;
  const download = async () => {
    setExporting(true);
    try {
      const allLogs: unknown[] = [];
      let next = 0;
      while (true) {
        const page = await (
          transport === "bot"
            ? utils.broadcast.getDeliveryPage
            : utils.mtproto.getDeliveryPage
        ).fetch({ id, offset: next, limit: 1000 });
        allLogs.push(...page.items);
        next += page.items.length;
        if (next >= page.total || !page.items.length) break;
      }
      const blob = new Blob(
        [
          JSON.stringify(
            {
              exportedAt: new Date().toISOString(),
              broadcast: bc,
              progress,
              logs: allLogs,
              note: "accepted означает успешный ответ API; чтение не подтверждается. dry_run — без отправки.",
            },
            null,
            2
          ),
        ],
        { type: "application/json" }
      );
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `tg-sender-${transport}-${id}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Не удалось выгрузить полный отчёт"
      );
    } finally {
      setExporting(false);
    }
  };
  return (
    <div className="p-5 lg:p-8 max-w-5xl mx-auto space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <Link
            href="/history"
            className="inline-flex items-center gap-2 text-xs text-primary mb-3"
          >
            <ArrowLeft className="h-3 w-3" />
            Все кампании
          </Link>
          <h1 className="text-2xl font-bold break-words">{bc.name}</h1>
          <p className="text-xs text-muted-foreground mt-1">
            #{id} · {transport === "bot" ? "Bot API" : "Telegram-аккаунт"} ·{" "}
            {new Date(bc.createdAt).toLocaleString("ru-RU")}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={exporting || logsQuery.isLoading || !!logsQuery.error}
            onClick={() => void download()}
          >
            <Download className="h-4 w-4" />
            JSON
          </Button>
          {!terminalStatuses.has(status) && (
            <Button
              variant="outline"
              size="sm"
              disabled={
                botCancel.isPending ||
                accountCancel.isPending ||
                status === "stopping"
              }
              onClick={async () => {
                try {
                  await (
                    transport === "bot" ? botCancel : accountCancel
                  ).mutateAsync({ id });
                  toast.info("Запрос остановки принят");
                  void query.refetch();
                } catch (error) {
                  toast.error(
                    error instanceof Error ? error.message : "Ошибка остановки"
                  );
                }
              }}
            >
              <Square className="h-4 w-4" />
              Остановить
            </Button>
          )}
        </div>
      </div>
      <div className="flex items-center gap-3">
        <StatusBadge status={status} />
        {bc.isDryRun && (
          <span className="text-xs text-muted-foreground">
            Проверка без отправки
          </span>
        )}
      </div>
      <section className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {[
          { label: "Всего", value: progress?.total ?? bc.totalRecipients },
          { label: "Принято Telegram", value: progress?.sent ?? bc.sentCount },
          { label: "Ошибки", value: progress?.failed ?? bc.failedCount },
          { label: "Неопределённо", value: additional?.unknown ?? 0 },
          { label: "Исключено", value: additional?.suppressed ?? 0 },
          { label: "Проверено", value: additional?.dryRun ?? 0 },
        ].map(item => (
          <div
            key={item.label}
            className="rounded-xl border border-border bg-card p-4"
          >
            <p className="text-xl font-semibold">{item.value}</p>
            <p className="text-xs text-muted-foreground mt-1">{item.label}</p>
          </div>
        ))}
      </section>
      <p className="text-xs text-muted-foreground">
        Успех API не подтверждает прочтение. Неопределённые результаты не
        повторяются автоматически.
      </p>
      <section className="rounded-xl border border-border bg-card p-5">
        <h2 className="font-medium text-sm mb-3">Утверждённое сообщение</h2>
        <MessagePreview message={bc.message} parseMode={bc.parseMode} />
      </section>
      <section className="space-y-3">
        <h2 className="font-medium">
          Журнал отправок{" "}
          <span className="text-muted-foreground text-sm">({total})</span>
        </h2>
        {logsQuery.error ? (
          <p className="text-sm text-red-400" role="alert">
            {logsQuery.error.message}
          </p>
        ) : !logs.length ? (
          <p className="text-sm text-muted-foreground">
            Записи появятся после обработки кампании.
          </p>
        ) : (
          <div className="rounded-xl border border-border overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-muted/40">
                <tr>
                  <th className="p-3">Получатель</th>
                  <th className="p-3">Результат</th>
                  <th className="p-3">Подробности</th>
                  <th className="p-3">Время</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {logs.map(log => {
                  const item = log as typeof log & {
                    chatId?: string;
                    recipient?: string;
                    status?: string;
                  };
                  return (
                    <tr key={log.id}>
                      <td className="p-3 font-mono whitespace-nowrap">
                        {item.chatId ?? item.recipient}
                      </td>
                      <td className="p-3">
                        <StatusBadge
                          status={
                            item.status ??
                            (bc.isDryRun
                              ? "dry_run"
                              : log.success
                                ? "accepted"
                                : "failed")
                          }
                        />
                      </td>
                      <td className="p-3 max-w-sm break-words">
                        {log.errorMessage ?? "—"}
                      </td>
                      <td className="p-3 whitespace-nowrap">
                        {new Date(log.sentAt).toLocaleString("ru-RU")}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex flex-wrap justify-between items-center gap-3 text-xs text-muted-foreground">
          <span>
            {total
              ? `${offset + 1}–${Math.min(offset + logs.length, total)} из ${total}`
              : "Нет записей"}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={offset === 0 || logsQuery.isFetching}
              onClick={() => setOffset(Math.max(0, offset - 100))}
            >
              Назад
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={offset + logs.length >= total || logsQuery.isFetching}
              onClick={() => setOffset(offset + 100)}
            >
              Далее
            </Button>
          </div>
        </div>
      </section>
      <ResolveUnknown
        transport={transport}
        id={id}
        rows={logs}
        onResolved={() => {
          void logsQuery.refetch();
          void query.refetch();
          void (transport === "bot" ? botProgress : accountProgress).refetch();
        }}
      />
    </div>
  );
}
