import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { getBotSettings, getMtprotoSession } from "./db";
import type { SenderKind } from "./delivery/types";
export async function senderFingerprint(ownerId: number, kind: SenderKind) {
  const secret =
    kind === "bot"
      ? (await getBotSettings(ownerId))?.botToken
      : (await getMtprotoSession(ownerId))?.sessionString;
  if (!secret)
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Сначала подключите выбранного отправителя",
    });
  return createHash("sha256").update(secret).digest("hex");
}
