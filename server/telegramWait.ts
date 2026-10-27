import {
  FloodTestPhoneWaitError,
  FloodWaitError,
  SlowModeWaitError,
} from "telegram/errors/index.js";

type TelegramWait = {
  category: "cooldown" | "slowmode";
  code: "FLOOD_WAIT" | "SLOWMODE_WAIT";
  seconds: number;
};

/** GramJS wait subclasses expose errorMessage="FLOOD", not the original RPC code. */
export function getTelegramWait(error: unknown): TelegramWait | null {
  try {
    let slowmode = false;
    let seconds: number;
    if (error instanceof SlowModeWaitError) {
      slowmode = true;
      seconds = error.seconds;
    } else if (
      error instanceof FloodWaitError ||
      error instanceof FloodTestPhoneWaitError
    ) {
      seconds = error.seconds;
    } else {
      const problem = error as {
        errorMessage?: unknown;
        seconds?: unknown;
      } | null;
      if (typeof problem?.errorMessage !== "string") return null;
      const match =
        /^(FLOOD_(?:PREMIUM_|TEST_PHONE_)?WAIT|SLOWMODE_WAIT)(?:_(\d+))?$/.exec(
          problem.errorMessage
        );
      if (!match) return null;
      slowmode = match[1] === "SLOWMODE_WAIT";
      const reported =
        typeof problem.seconds === "number" ? problem.seconds : NaN;
      const encoded = match[2] === undefined ? NaN : Number(match[2]);
      // Preserve the longer value if a canonical fallback contains both forms.
      const valid = [reported, encoded].filter(
        value => Number.isFinite(value) && value > 0
      );
      if (!valid.length) return null;
      seconds = Math.max(...valid);
    }
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    return {
      category: slowmode ? "slowmode" : "cooldown",
      code: slowmode ? "SLOWMODE_WAIT" : "FLOOD_WAIT",
      seconds: Math.ceil(seconds),
    };
  } catch {
    // Diagnostics and classification must not execute hostile metadata getters.
    return null;
  }
}
