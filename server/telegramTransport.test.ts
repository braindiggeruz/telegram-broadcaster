import { describe, it, expect } from "vitest";
import {
  classifyBotError,
  classifyMtprotoError,
  photoUploadFailureDiagnostic,
} from "./telegramTransport";
import { DeliveryError } from "./delivery/types";
describe("Telegram rejection classifier", () => {
  it("uses server wait and leaves uncertain errors unknown", () => {
    expect(
      classifyBotError({
        ok: false,
        error_code: 429,
        parameters: { retry_after: 123 },
      })
    ).toMatchObject({ category: "cooldown", retryAfterSeconds: 123 });
    expect(
      classifyBotError({
        ok: false,
        error_code: 502,
        description: "proxy error",
      })
    ).not.toBeInstanceOf(DeliveryError);
  });
  it("does not confuse a deleted recipient with sender restriction", () => {
    expect(
      classifyMtprotoError({ errorMessage: "INPUT_USER_DEACTIVATED" })
    ).toMatchObject({ category: "recipient" });
    expect(
      classifyMtprotoError({ errorMessage: "USER_DEACTIVATED" })
    ).toMatchObject({ category: "restricted" });
    expect(classifyMtprotoError({ errorMessage: "PEER_FLOOD" })).toMatchObject({
      category: "restricted",
    });
    expect(
      classifyMtprotoError({ errorMessage: "PHONE_NOT_OCCUPIED" })
    ).toMatchObject({
      category: "recipient",
      code: "PHONE_NOT_OCCUPIED",
    });
    expect(
      classifyMtprotoError({ errorMessage: "FLOOD_WAIT_600", seconds: 600 })
    ).toMatchObject({ category: "cooldown", retryAfterSeconds: 600 });
    expect(
      classifyMtprotoError(new Error("socket disconnected"))
    ).not.toBeInstanceOf(DeliveryError);
  });
});

describe("safe photo-upload diagnostics", () => {
  it.each([
    [
      { errorMessage: "FILE_PART_INVALID", name: "BadRequestError" },
      "FILE_PART_INVALID",
      "BadRequestError",
    ],
    [
      { errorMessage: "FLOOD_WAIT_123", name: "FloodWaitError" },
      "FLOOD_WAIT",
      "FloodWaitError",
    ],
    [{ errorMessage: "FLOOD_PREMIUM_WAIT_123" }, "FLOOD_WAIT", "UNKNOWN"],
    [
      { errorMessage: "FILE_MIGRATE_4", name: "FileMigrateError" },
      "FILE_MIGRATE",
      "FileMigrateError",
    ],
    [{ errorMessage: "FILE_PART_2_MISSING" }, "FILE_PART_MISSING", "UNKNOWN"],
    [{ code: "ECONNRESET", name: "Error" }, "ECONNRESET", "Error"],
    [
      { code: "ERR_INVALID_ARG_TYPE", name: "TypeError" },
      "ERR_INVALID_ARG_TYPE",
      "TypeError",
    ],
    [
      new Error("Request was unsuccessful 1 time(s)"),
      "SDK_RETRY_EXHAUSTED",
      "Error",
    ],
    [
      "Maximum reconnection retries reached. Aborting!",
      "RECONNECT_EXHAUSTED",
      "UNKNOWN",
    ],
    [new Error("NetSocket was closed"), "SOCKET_CLOSED", "Error"],
    [new Error("Not connected"), "TRANSPORT_DISCONNECTED", "Error"],
    [new Error("Auth key unset"), "AUTH_KEY_UNSET", "Error"],
    [new Error("Not a valid string"), "INVALID_SESSION_FORMAT", "Error"],
  ])("returns only allowlisted metadata", (error, reason, name) => {
    expect(photoUploadFailureDiagnostic(error)).toEqual({
      event: "telegram_media_failure",
      stage: "upload_part",
      reason,
      name,
    });
  });

  it("never copies secret-bearing message, stack, name, RPC or system code", () => {
    const secret = "synthetic-private-photo-session-value";
    const error = Object.assign(new Error(secret), {
      stack: secret,
      name: secret,
      errorMessage: secret,
      code: secret,
      bytes: Buffer.from(secret),
      phone: secret,
      sessionString: secret,
    });
    const diagnostic = photoUploadFailureDiagnostic(error);
    expect(diagnostic).toEqual({
      event: "telegram_media_failure",
      stage: "upload_part",
      reason: "UNKNOWN",
      name: "UNKNOWN",
    });
    expect(JSON.stringify(diagnostic)).not.toContain(secret);
  });

  it("does not accept a fixed string with appended private information", () => {
    const secret = "synthetic-private-session-value";
    const diagnostic = photoUploadFailureDiagnostic(
      `Maximum reconnection retries reached. Aborting! ${secret}`
    );
    expect(diagnostic.reason).toBe("UNKNOWN");
    expect(JSON.stringify(diagnostic)).not.toContain(secret);
  });

  it.each([null, undefined, "synthetic-private-exception"])(
    "handles non-object exceptions without leaking them",
    error => {
      expect(photoUploadFailureDiagnostic(error)).toEqual({
        event: "telegram_media_failure",
        stage: "upload_part",
        reason: "UNKNOWN",
        name: "UNKNOWN",
      });
    }
  );

  it("does not let an exception metadata getter break diagnostics", () => {
    const error = Object.defineProperty({}, "errorMessage", {
      get() {
        throw new Error("synthetic-private-getter");
      },
    });
    expect(photoUploadFailureDiagnostic(error)).toEqual({
      event: "telegram_media_failure",
      stage: "upload_part",
      reason: "UNKNOWN",
      name: "UNKNOWN",
    });
  });
});
