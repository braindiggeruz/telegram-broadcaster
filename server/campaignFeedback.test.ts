import { describe, expect, it } from "vitest";
import {
  campaignDisplayStatus,
  campaignQueueNotice,
  deliveryDetail,
  deliveryDisplayStatus,
} from "../client/src/lib/campaignFeedback";

import { statusLabels } from "../client/src/components/StatusBadge";

describe("campaign queue feedback", () => {
  const paused = {
    status: "running",
    pending: 209,
    inflight: 0,
    retryPending: 71,
    sender: { state: "DISABLED", reason: "DIAGNOSTIC_PAUSE" },
  };

  it("shows a diagnostic pause while retaining the actual queued and retry counts", () => {
    expect(campaignDisplayStatus(paused)).toBe("paused");
    expect(campaignQueueNotice(paused)).toContain(
      "Диагностика: очередь сохранена"
    );
    expect(paused.pending).toBe(209);
    expect(paused.retryPending).toBe(71);
  });

  it("does not call an idle queued campaign actively sending", () => {
    expect(
      campaignDisplayStatus({ ...paused, sender: { state: "READY" } })
    ).toBe("queued");
    expect(
      campaignDisplayStatus({
        ...paused,
        inflight: 1,
        sender: { state: "READY" },
      })
    ).toBe("running");
    expect(
      campaignQueueNotice({ ...paused, sender: { state: "READY" } })
    ).toContain("ещё не приняты Telegram");
  });

  it("explains FLOOD_WAIT without diagnosing a spam ban or promising the next attempt will succeed", () => {
    const cooldown = {
      ...paused,
      sender: { state: "COOLDOWN", reason: "FLOOD_WAIT" },
    };
    expect(campaignDisplayStatus(cooldown)).toBe("cooldown");
    const notice = campaignQueueNotice(cooldown);
    expect(notice).toContain(
      "Telegram API запросил временную паузу (FLOOD_WAIT)"
    );
    expect(notice).toContain("не подтверждает спам-блокировку");
    expect(notice).toContain(
      "после окончания паузы обработка повторится автоматически"
    );
    expect(notice).toContain("может назначить новое ожидание");
  });

  it("keeps other cooldown reasons distinct", () => {
    expect(
      campaignQueueNotice({
        ...paused,
        sender: { state: "COOLDOWN", reason: "SENDER_PACING" },
      })
    ).toBe(
      "Telegram запросил паузу. Очередь сохранена; обработка продолжится после ожидания."
    );
  });

  it("keeps stop and terminal states above sender pause notices", () => {
    expect(campaignDisplayStatus({ ...paused, status: "stopping" })).toBe(
      "stopping"
    );
    expect(campaignDisplayStatus({ ...paused, status: "completed" })).toBe(
      "completed"
    );
    expect(campaignQueueNotice({ ...paused, status: "completed" })).toBeNull();
  });

  it.each(["COOLDOWN", "DISABLED", "AUTH_REQUIRED", "REVIEW_REQUIRED"])(
    "keeps a dry run independent from sender %s",
    state => {
      const dryRun = {
        ...paused,
        isDryRun: true,
        sender: { state, reason: "DIAGNOSTIC_PAUSE" },
      };
      expect(campaignDisplayStatus(dryRun)).toBe("queued");
      expect(campaignQueueNotice(dryRun)).toBeNull();
    }
  );

  it("explains a privacy or unavailable-number rejection without promising discovery", () => {
    expect(deliveryDetail("PHONE_NOT_OCCUPIED")).toBe(
      "Номер не найден или поиск скрыт настройками Telegram"
    );
    expect(deliveryDetail("MTPROTO_RESOLUTION_UNAVAILABLE")).toContain(
      "Временный сбой поиска; повтор"
    );
    expect(deliveryDetail("MTPROTO_RESOLUTION_UNAVAILABLE")).toContain(
      "Сообщение не отправлено"
    );
  });
});

describe("delivery feedback", () => {
  it.each([undefined, null, "", "   "])(
    "shows an untouched pending delivery as queued (%s)",
    error => {
      expect(deliveryDisplayStatus("pending", error)).toBe("queued");
    }
  );

  it.each(["FLOOD_WAIT", "MTPROTO_RESOLUTION_UNAVAILABLE", "SLOWMODE_WAIT_60"])(
    "shows a pending delivery with %s as awaiting retry",
    error => {
      expect(deliveryDisplayStatus("pending", error)).toBe("retry_pending");
    }
  );

  it.each([
    "accepted",
    "failed",
    "unknown",
    "inflight",
    "dry_run",
    "suppressed",
  ])("preserves the %s delivery state even with an error", status => {
    expect(deliveryDisplayStatus(status, "FLOOD_WAIT")).toBe(status);
  });

  it("keeps the campaign pending label while using contextual delivery labels", () => {
    expect(statusLabels.pending).toBe("Подготовлена");
    expect(statusLabels[deliveryDisplayStatus("pending", null)]).toBe(
      "В очереди"
    );
    expect(statusLabels[deliveryDisplayStatus("pending", "FLOOD_WAIT")]).toBe(
      "Ожидает повтора"
    );
  });

  it.each([
    "FLOOD_WAIT",
    "FLOOD_WAIT_2090",
    "FLOOD_PREMIUM_WAIT_60",
    "FLOOD_TEST_PHONE_WAIT_60",
  ])("explains %s as a wait without claiming delivery", code => {
    expect(deliveryDetail(code)).toContain(
      "Telegram API запросил временную паузу"
    );
    expect(deliveryDetail(code)).toContain("Отправка не подтверждена");
    expect(deliveryDetail(code)).toContain("после ожидания");
  });

  it.each(["SLOWMODE_WAIT", "SLOWMODE_WAIT_120"])(
    "explains %s as a chat-specific rate limit",
    code => {
      expect(deliveryDetail(code)).toContain("в этом чате");
      expect(deliveryDetail(code)).toContain("Отправка не подтверждена");
    }
  );

  it("explains invalid recipients and exhausted retries without promising discovery or delivery", () => {
    expect(deliveryDetail("PHONE_NUMBER_INVALID")).toContain(
      "международный формат"
    );
    expect(deliveryDetail("PHONE_NUMBER_INVALID")).toContain(
      "поиск получателя не гарантирован"
    );
    expect(deliveryDetail("USERNAME_INVALID")).toContain("Проверьте username");
    expect(deliveryDetail("UNSENT_RETRY_EXHAUSTED")).toContain(
      "Сообщение не отправлено"
    );
    expect(deliveryDetail("UNSENT_RETRY_EXHAUSTED")).toContain(
      "автоматические повторы остановлены"
    );
  });

  it("retains unknown reasons and handles missing details", () => {
    expect(deliveryDetail("UNRECOGNIZED_CODE")).toBe("UNRECOGNIZED_CODE");
    expect(deliveryDetail(null)).toBe("—");
    expect(deliveryDetail(undefined)).toBe("—");
  });
});
