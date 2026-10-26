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

export function deliveryDetail(reason: string | null | undefined) {
  if (reason === "CONTACT_PERMISSION_MISSING") {
    return "Нет подтверждения для этого отправителя. Не связано с контактами Telegram";
  }
  if (reason === "CONTACT_SUPPRESSED") {
    return "Получатель исключён или отписался";
  }
  return reason ?? "—";
}
