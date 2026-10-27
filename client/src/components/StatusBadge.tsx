import { Badge } from "@/components/ui/badge";
export const statusLabels: Record<string, string> = {
  pending: "Подготовлена",
  queued: "В очереди",
  retry_pending: "Ожидает повтора",
  running: "Выполняется",
  completed: "Завершена",
  failed: "Ошибка",
  cancelled: "Остановлена",
  stopping: "Останавливается",
  stopped: "Остановлена",
  expired: "Срок отправки истёк",
  inflight: "Отправляется",
  paused: "Приостановлена",
  cooldown: "Ожидает Telegram",
  review_required: "Нужно действие",
  auth_required: "Нужен вход",
  unknown: "Результат неизвестен",
  suppressed: "Исключён",
  accepted: "Принято Telegram",
  sent: "Принято Telegram",
  dry_run: "Проверено без отправки",
  READY: "Готов",
  COOLDOWN: "Ожидание",
  REVIEW_REQUIRED: "Нужно действие",
  AUTH_REQUIRED: "Нужен вход",
  DISABLED: "Отключён",
};
export const terminalStatuses = new Set([
  "completed",
  "failed",
  "cancelled",
  "stopped",
  "expired",
]);
export default function StatusBadge({ status }: { status: string }) {
  return (
    <Badge
      variant="outline"
      className={
        status === "completed" || status === "accepted" || status === "READY"
          ? "text-emerald-400 border-emerald-500/30"
          : status === "failed" ||
              status === "review_required" ||
              status === "REVIEW_REQUIRED"
            ? "text-amber-400 border-amber-500/30"
            : "text-muted-foreground"
      }
    >
      {statusLabels[status] ?? status}
    </Badge>
  );
}
