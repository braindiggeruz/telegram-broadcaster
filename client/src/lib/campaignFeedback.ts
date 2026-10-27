export type StopFeedback = {
  tone: "success" | "info" | "error";
  message: string;
  uncertain: boolean;
};

/** A failed response does not prove that the cancellation write failed. */
export async function confirmCampaignStop(options: {
  request?: () => Promise<unknown>;
  read: () => Promise<{ status: string } | null | undefined>;
}): Promise<StopFeedback> {
  if (options.request) {
    try {
      await options.request();
    } catch {
      // Always read back; never repeat a write automatically.
    }
  }
  try {
    const result = await options.read();
    if (!result) throw new Error("Missing campaign state");
    if (result.status === "stopped" || result.status === "cancelled") {
      return {
        tone: "success",
        message: "Кампания остановлена.",
        uncertain: false,
      };
    }
    if (result.status === "stopping") {
      return {
        tone: "info",
        message: "Остановка принята. Обработчик завершает текущую операцию.",
        uncertain: false,
      };
    }
    if (["completed", "failed", "expired"].includes(result.status)) {
      return {
        tone: "info",
        message: "Кампания уже завершена. Новые отправки не выполняются.",
        uncertain: false,
      };
    }
    return {
      tone: "error",
      message:
        "Остановка пока не подтверждена. Можно повторить запрос вручную кнопкой «Остановить».",
      uncertain: false,
    };
  } catch {
    return {
      tone: "error",
      message: "Не удалось проверить остановку. Нажмите «Проверить состояние».",
      uncertain: true,
    };
  }
}

export function deliveryDisplayStatus(
  status: string,
  errorMessage: string | null | undefined
) {
  if (status !== "pending") return status;
  return errorMessage?.trim() ? "retry_pending" : "queued";
}

export function deliveryDetail(reason: string | null | undefined) {
  if (/^FLOOD_(?:PREMIUM_|TEST_PHONE_)?WAIT(?:_\d+)?$/.test(reason ?? "")) {
    return "Telegram API запросил временную паузу. Отправка не подтверждена; повтор возможен после ожидания";
  }
  if (/^SLOWMODE_WAIT(?:_\d+)?$/.test(reason ?? "")) {
    return "Telegram ограничил частоту сообщений в этом чате. Отправка не подтверждена; повтор возможен после ожидания";
  }
  if (reason === "PHONE_NUMBER_INVALID") {
    return "Telegram отклонил номер телефона. Проверьте международный формат; поиск получателя не гарантирован";
  }
  if (reason === "USERNAME_INVALID") {
    return "Telegram отклонил имя пользователя. Проверьте username получателя";
  }
  if (reason === "UNSENT_RETRY_EXHAUSTED") {
    return "Лимит повторов после временных сбоев исчерпан. Сообщение не отправлено; автоматические повторы остановлены";
  }
  if (reason === "PHONE_NOT_OCCUPIED") {
    return "Номер не найден или поиск скрыт настройками Telegram";
  }
  if (reason === "MTPROTO_RESOLUTION_UNAVAILABLE") {
    return "Временный сбой поиска; повтор ожидает очереди. Сообщение не отправлено";
  }
  if (reason === "CONTACT_PERMISSION_MISSING") {
    return "Нет подтверждения для этого отправителя. Не связано с контактами Telegram";
  }
  if (reason === "CONTACT_SUPPRESSED") {
    return "Получатель исключён или отписался";
  }
  return reason ?? "—";
}

export type CampaignQueueProgress = {
  status: string;
  isDryRun?: boolean;
  pending?: number;
  inflight?: number;
  retryPending?: number;
  nextAttemptAt?: Date | string | null;
  lastActivityAt?: Date | string | null;
  sender?: {
    state: string;
    reason?: string | null;
    cooldownUntil?: Date | string | null;
  } | null;
};

export function campaignDisplayStatus(progress: CampaignQueueProgress) {
  if (!["queued", "running"].includes(progress.status)) return progress.status;
  if (!progress.isDryRun) {
    if (progress.sender?.state === "DISABLED") return "paused";
    if (progress.sender?.state === "AUTH_REQUIRED") return "auth_required";
    if (progress.sender?.state === "REVIEW_REQUIRED") return "review_required";
    if (progress.sender?.state === "COOLDOWN") return "cooldown";
  }
  if (!progress.inflight && (progress.pending ?? 0) > 0) return "queued";
  return progress.status;
}

export function campaignQueueNotice(progress: CampaignQueueProgress) {
  if (!["queued", "running"].includes(progress.status)) return null;
  if (progress.isDryRun) return null;
  if (progress.sender?.state === "DISABLED")
    return progress.sender.reason === "DIAGNOSTIC_PAUSE"
      ? "Диагностика: очередь сохранена. Отправка приостановлена; ожидающие получатели не потеряны."
      : "Отправитель приостановлен. Очередь сохранена.";
  if (progress.sender?.state === "AUTH_REQUIRED")
    return "Нужно повторно подключить отправителя. Очередь сохранена.";
  if (progress.sender?.state === "REVIEW_REQUIRED")
    return "Telegram ограничил отправителя. Требуется проверка; очередь сохранена.";
  if (progress.sender?.state === "COOLDOWN")
    return progress.sender.reason === "FLOOD_WAIT"
      ? "Telegram API запросил временную паузу (FLOOD_WAIT). Этот ответ сам по себе не подтверждает спам-блокировку аккаунта. Очередь сохранена; после окончания паузы обработка повторится автоматически. Telegram может назначить новое ожидание."
      : "Telegram запросил паузу. Очередь сохранена; обработка продолжится после ожидания.";
  if ((progress.retryPending ?? 0) > 0)
    return "Часть очереди ожидает повтора после подтверждённого отсутствия отправки. Эти сообщения ещё не приняты Telegram.";
  return null;
}

export function formatCampaignTime(value: Date | string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("ru-RU") : null;
}
