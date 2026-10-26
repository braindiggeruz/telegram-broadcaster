import { trpc } from "@/lib/trpc";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import StatusBadge, { terminalStatuses } from "@/components/StatusBadge";
import {
  History,
  Square,
  ArrowRight,
  RefreshCw,
  Bot,
  UserRound,
} from "lucide-react";
import { toast } from "sonner";
export default function BroadcastHistory() {
  const bot = trpc.broadcast.list.useQuery(undefined, {
    refetchInterval: 5000,
  });
  const account = trpc.mtproto.listBroadcasts.useQuery(undefined, {
    refetchInterval: 5000,
  });
  const botCancel = trpc.broadcast.cancel.useMutation();
  const accountCancel = trpc.mtproto.cancelBroadcast.useMutation();
  const rows = [
    ...(bot.data ?? []).map(item => ({ ...item, transport: "bot" as const })),
    ...(account.data ?? []).map(item => ({
      ...item,
      transport: "mtproto" as const,
    })),
  ].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
  return (
    <div className="p-5 lg:p-8 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Все кампании</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Возвращайтесь к прогрессу и управлению после перезагрузки страницы.
          </p>
        </div>
        <Button
          aria-label="Обновить кампании"
          size="icon"
          variant="outline"
          onClick={() => {
            void bot.refetch();
            void account.refetch();
          }}
        >
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>
      {(bot.error || account.error) && (
        <p role="alert" className="text-sm text-red-400">
          {bot.error?.message ?? account.error?.message}
        </p>
      )}
      {bot.isLoading || account.isLoading ? (
        <p className="text-sm text-muted-foreground">Загружаем кампании…</p>
      ) : !rows.length ? (
        <section className="rounded-xl border border-border bg-card p-10 text-center space-y-3">
          <History className="h-8 w-8 text-muted-foreground mx-auto" />
          <p className="text-sm text-muted-foreground">
            Кампаний пока нет. Начните с проверки без отправки.
          </p>
          <Link href="/launch">
            <Button>Создать кампанию</Button>
          </Link>
        </section>
      ) : (
        <div className="space-y-3">
          {rows.map(item => (
            <article
              key={`${item.transport}:${item.id}`}
              className="rounded-xl border border-border bg-card p-4 flex flex-wrap items-center gap-4"
            >
              <div className="rounded-xl bg-primary/10 p-3">
                {item.transport === "bot" ? (
                  <Bot className="h-5 w-5 text-primary" />
                ) : (
                  <UserRound className="h-5 w-5 text-primary" />
                )}
              </div>
              <div className="flex-1 min-w-40">
                <p className="font-medium">{item.name}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {item.transport === "bot" ? "Бот" : "Аккаунт"} ·{" "}
                  {item.totalRecipients} получателей ·{" "}
                  {new Date(item.createdAt).toLocaleString("ru-RU")}
                </p>
                <div className="flex flex-wrap gap-2 mt-2">
                  <StatusBadge status={item.queueStatus ?? item.status} />
                  {item.isDryRun && (
                    <span className="text-xs text-muted-foreground">
                      Проверка без отправки
                    </span>
                  )}
                </div>
              </div>
              <div className="flex gap-2">
                {!terminalStatuses.has(item.queueStatus ?? item.status) && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={botCancel.isPending || accountCancel.isPending}
                    onClick={async () => {
                      try {
                        await (
                          item.transport === "bot" ? botCancel : accountCancel
                        ).mutateAsync({ id: item.id });
                        toast.info(
                          "Запрошена остановка. Состояние обновится после подтверждения обработчиком."
                        );
                        void bot.refetch();
                        void account.refetch();
                      } catch (error) {
                        toast.error(
                          error instanceof Error
                            ? error.message
                            : "Ошибка остановки"
                        );
                      }
                    }}
                  >
                    <Square className="h-3 w-3" />
                    Остановить
                  </Button>
                )}
                <Link
                  href={
                    item.transport === "bot"
                      ? `/history/${item.id}`
                      : `/user-broadcast-report/${item.id}`
                  }
                >
                  <Button size="sm" variant="outline">
                    Открыть
                    <ArrowRight className="h-3 w-3" />
                  </Button>
                </Link>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
