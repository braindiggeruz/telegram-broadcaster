import { describe, expect, it } from "vitest";
import {
  campaignDisplayStatus,
  campaignQueueNotice,
  deliveryDetail,
} from "../client/src/lib/campaignFeedback";

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
