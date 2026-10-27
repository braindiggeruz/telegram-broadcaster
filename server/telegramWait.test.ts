import { describe, expect, it } from "vitest";
import { Api } from "telegram";
import {
  FloodTestPhoneWaitError,
  FloodWaitError,
  RPCMessageToError,
  SlowModeWaitError,
} from "telegram/errors/index.js";
import { getTelegramWait } from "./telegramWait";

const request = new Api.contacts.ResolvePhone({ phone: "+19990000000" });

describe("real GramJS mandatory wait recognition", () => {
  it.each([
    [FloodWaitError, "cooldown", "FLOOD_WAIT"],
    [FloodTestPhoneWaitError, "cooldown", "FLOOD_WAIT"],
    [SlowModeWaitError, "slowmode", "SLOWMODE_WAIT"],
  ] as const)(
    "recognizes the SDK %s despite its generic FLOOD code",
    (WaitError, category, code) => {
      const error = new WaitError({ capture: 2090, request });
      expect(error.errorMessage).toBe("FLOOD");
      expect(getTelegramWait(error)).toEqual({ category, code, seconds: 2090 });
    }
  );

  it.each([
    ["FLOOD_WAIT_2090", "cooldown", "FLOOD_WAIT", 2090],
    ["FLOOD_PREMIUM_WAIT_3456", "cooldown", "FLOOD_WAIT", 3456],
    ["FLOOD_TEST_PHONE_WAIT_900", "cooldown", "FLOOD_WAIT", 900],
    ["SLOWMODE_WAIT_600", "slowmode", "SLOWMODE_WAIT", 600],
  ] as const)(
    "recognizes the real RPC converter output for %s",
    (rpc, category, code, seconds) => {
      const error = RPCMessageToError(
        new Api.RpcError({ errorCode: 420, errorMessage: rpc }),
        request
      );
      expect(error.errorMessage).toBe("FLOOD");
      expect(getTelegramWait(error)).toEqual({ category, code, seconds });
    }
  );

  it("rounds a fractional mandatory wait up instead of shortening it", () => {
    expect(
      getTelegramWait(new FloodWaitError({ capture: 2090.25, request }))
        ?.seconds
    ).toBe(2091);
  });

  it.each([0, -1, NaN, Infinity, -Infinity, "2090", null, undefined])(
    "rejects invalid SDK wait duration %s",
    seconds => {
      const error = new FloodWaitError({ capture: 2090, request });
      Object.assign(error, { seconds });
      expect(getTelegramWait(error)).toBeNull();
    }
  );

  it.each([
    [{ errorMessage: "FLOOD_WAIT_2090", seconds: 60 }, 2090],
    [{ errorMessage: "FLOOD_WAIT_60", seconds: 2090 }, 2090],
    [{ errorMessage: "FLOOD_PREMIUM_WAIT_2090" }, 2090],
    [{ errorMessage: "FLOOD_TEST_PHONE_WAIT_2090" }, 2090],
  ])(
    "keeps the longer complete canonical fallback duration",
    (error, seconds) => {
      expect(getTelegramWait(error)).toEqual({
        category: "cooldown",
        code: "FLOOD_WAIT",
        seconds,
      });
    }
  );

  it("does not infer waits from generic names, messages or malformed metadata", () => {
    for (const error of [
      { errorMessage: "FLOOD", seconds: 2090 },
      {
        name: "FloodWaitError",
        message: "synthetic-private-request",
        seconds: 2090,
      },
      { errorMessage: "FLOOD_WAIT", seconds: Infinity },
      { errorMessage: "FLOOD_WAIT_0", seconds: -1 },
      Object.defineProperty({}, "errorMessage", {
        get() {
          throw new Error("synthetic-private-value");
        },
      }),
      null,
      undefined,
    ])
      expect(getTelegramWait(error)).toBeNull();
  });
});
