import { trpc } from "@/lib/trpc";
import { Link } from "wouter";
import {
  Bot,
  Users,
  MessageSquare,
  Rocket,
  Zap,
  CheckCircle2,
  ArrowRight,
  Clock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import StatusBadge from "@/components/StatusBadge";
export default function DashboardHome() {
  const stats = trpc.stats.dashboard.useQuery(undefined, {
    refetchInterval: 10000,
  });
  const bot = trpc.bot.get.useQuery();
  const lists = trpc.recipients.list.useQuery();
  const draft = trpc.draft.get.useQuery({ key: "bot" });
  const health = trpc.operations.status.useQuery(undefined, {
    refetchInterval: 10000,
  });
  const steps = [
    {
      href: "/bot-token",
      icon: Bot,
      title: "Подключите бота",
      detail: "Один раз сохраните токен",
      done: !!bot.data?.isValid,
    },
    {
      href: "/recipients",
      icon: Users,
      title: "Добавьте аудиторию",
      detail: "Импорт с проверкой получателей",
      done: !!lists.data?.length,
    },
    {
      href: "/composer",
      icon: MessageSquare,
      title: "Подготовьте сообщение",
      detail: "Автосохранение и предпросмотр",
      done: !!draft.data?.message.trim(),
    },
    {
      href: "/launch",
      icon: Rocket,
      title: "Проверьте кампанию",
      detail: "Начните без реальной отправки",
      done: false,
    },
  ];
  return (
    <div className="p-5 lg:p-8 max-w-6xl mx-auto space-y-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-widest text-primary mb-2">
            TG Sender 2.0
          </p>
          <h1 className="text-2xl lg:text-3xl font-bold">
            Меньше рутины. Больше контроля.
          </h1>
          <p className="text-sm text-muted-foreground mt-2">
            Настройте аудиторию и правила — система возьмёт на себя очередь и
            ожидания.
          </p>
        </div>
        <Link href="/autopilot">
          <Button>
            <Zap className="h-4 w-4" />
            Автопилот
          </Button>
        </Link>
      </div>
      {(stats.error || health.error) && (
        <p role="alert" className="text-sm text-red-400">
          {stats.error?.message ?? health.error?.message}
        </p>
      )}
      <section className="grid sm:grid-cols-3 gap-4">
        {[
          {
            label: "Кампаний",
            value: stats.data?.totalBroadcasts,
            detail: "В истории сервиса",
          },
          {
            label: "Принято Telegram",
            value: stats.data?.totalMessagesSent,
            detail: "Успешные ответы API, не прочтения",
          },
          {
            label: "Обработчик очереди",
            value: health.data
              ? health.data.worker.running
                ? "Активен"
                : "Ожидает"
              : undefined,
            detail: health.data?.worker.lastHeartbeatAt
              ? `Сигнал: ${new Date(health.data.worker.lastHeartbeatAt).toLocaleTimeString("ru-RU")}`
              : "Ожидаем свежий сигнал",
          },
        ].map(item => (
          <div key={item.label} className="stat-card">
            <p className="text-xs text-muted-foreground">{item.label}</p>
            <p className="text-2xl font-semibold mt-3">{item.value ?? "—"}</p>
            <p className="text-xs text-muted-foreground mt-2">{item.detail}</p>
          </div>
        ))}
      </section>
      {!!health.data?.exceptions.length && (
        <Link href="/autopilot">
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 flex items-center justify-between gap-3 text-sm">
            <span>
              Нужно действие: {health.data.exceptions.length}. Остальная работа
              остаётся в очереди.
            </span>
            <ArrowRight className="h-4 w-4 shrink-0" />
          </div>
        </Link>
      )}
      <section className="space-y-4">
        <h2 className="font-semibold">Быстрый старт</h2>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {steps.map((step, index) => (
            <Link
              key={step.href}
              href={step.href}
              className="rounded-xl border border-border bg-card hover:border-primary/40 transition-colors p-5"
            >
              <div className="flex items-center justify-between mb-4">
                <step.icon className="h-5 w-5 text-primary" />
                {step.done ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                ) : (
                  <span className="text-xs text-muted-foreground">
                    0{index + 1}
                  </span>
                )}
              </div>
              <p className="text-sm font-semibold">{step.title}</p>
              <p className="text-xs text-muted-foreground mt-2">
                {step.detail}
              </p>
            </Link>
          ))}
        </div>
      </section>
      <section className="space-y-4">
        <div className="flex justify-between items-center gap-3">
          <h2 className="font-semibold">Последние кампании бота</h2>
          <Link href="/history" className="text-xs text-primary">
            Все кампании →
          </Link>
        </div>
        {stats.isLoading ? (
          <p className="text-sm text-muted-foreground">Загружаем историю…</p>
        ) : !stats.data?.recentBroadcasts.length ? (
          <div className="rounded-xl border border-border bg-card p-8 text-center">
            <Clock className="h-7 w-7 mx-auto text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground">
              История появится после первой проверки кампании.
            </p>
          </div>
        ) : (
          <div className="rounded-xl border border-border bg-card divide-y divide-border">
            {stats.data.recentBroadcasts.map(item => (
              <Link
                key={item.id}
                href={`/history/${item.id}`}
                className="flex flex-wrap items-center gap-4 p-4 hover:bg-muted/30"
              >
                <div className="flex-1 min-w-40">
                  <p className="font-medium text-sm">{item.name}</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {item.totalRecipients} получателей ·{" "}
                    {new Date(item.createdAt).toLocaleDateString("ru-RU")}
                  </p>
                </div>
                <StatusBadge status={item.status} />
                <ArrowRight className="h-4 w-4 text-muted-foreground" />
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
