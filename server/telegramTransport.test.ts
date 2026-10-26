import { describe, it, expect } from "vitest";
import { classifyBotError, classifyMtprotoError } from "./telegramTransport";
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
