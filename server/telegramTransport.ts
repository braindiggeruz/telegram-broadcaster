import { Api } from "telegram";
import bigInt from "big-integer";
import { createHash } from "node:crypto";
import { _parseMessageText } from "telegram/client/messageParse.js";
import { getBotSettings, getMtprotoSession } from "./db";
import { createClient } from "./mtproto";
import {
  DeliveryError,
  type DeliveryTransport,
  type DeliveryRequest,
} from "./delivery/types";

type BotResponse = {
  ok: boolean;
  result?: unknown;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
};
export async function telegramRequest(
  token: string,
  method: "getMe" | "sendMessage" | "setWebhook",
  body?: Record<string, unknown>,
  signal?: AbortSignal
): Promise<BotResponse> {
  const timeout = AbortSignal.timeout(15000);
  const response = await fetch(
    `https://api.telegram.org/bot${token}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      redirect: "error",
    }
  );
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error("TELEGRAM_RESPONSE_UNKNOWN");
  }
  if (
    !value ||
    typeof value !== "object" ||
    !("ok" in value) ||
    typeof value.ok !== "boolean"
  )
    throw new Error("TELEGRAM_RESPONSE_UNKNOWN");
  return value as BotResponse;
}
export function classifyBotError(result: BotResponse): DeliveryError | Error {
  if (
    result.error_code === 429 &&
    Number.isFinite(result.parameters?.retry_after)
  )
    return new DeliveryError(
      "cooldown",
      "BOT_RATE_LIMIT",
      Math.max(1, result.parameters!.retry_after!)
    );
  if (result.error_code === 401)
    return new DeliveryError("auth", "BOT_UNAUTHORIZED");
  if (result.error_code === 403)
    return new DeliveryError("recipient", "BOT_RECIPIENT_FORBIDDEN");
  const description = (result.description ?? "").toLowerCase();
  if (
    result.error_code === 400 &&
    /chat not found|user is deactivated|peer_id_invalid/.test(description)
  )
    return new DeliveryError("recipient", "BOT_RECIPIENT_UNAVAILABLE");
  if (
    result.error_code === 400 &&
    /parse entities|message is too long|message text is empty|entity/.test(
      description
    )
  )
    return new DeliveryError("content", "BOT_INVALID_CONTENT");
  // Ambiguous server/proxy errors remain unknown, including 5xx.
  return new Error("BOT_RESULT_UNKNOWN");
}
export function classifyMtprotoError(error: unknown): DeliveryError | Error {
  const e = error as { errorMessage?: string; seconds?: number };
  const code = e?.errorMessage;
  if (!code) return new Error("MTPROTO_RESULT_UNKNOWN");
  if (
    /^INPUT_USER_DEACTIVATED$|^USER_PRIVACY_RESTRICTED$|^USER_IS_BLOCKED$|^YOU_BLOCKED_USER$|^PEER_ID_INVALID$|^USERNAME_NOT_OCCUPIED$|^CHAT_WRITE_FORBIDDEN$/.test(
      code
    )
  )
    return new DeliveryError("recipient", code);
  if (/^FLOOD_WAIT(?:_\d+)?$|^FLOOD_PREMIUM_WAIT(?:_\d+)?$/.test(code))
    return new DeliveryError(
      "cooldown",
      "FLOOD_WAIT",
      e.seconds ?? Number(code.match(/\d+$/)?.[0] ?? 60)
    );
  if (/^SLOWMODE_WAIT(?:_\d+)?$/.test(code))
    return new DeliveryError(
      "slowmode",
      "SLOWMODE_WAIT",
      e.seconds ?? Number(code.match(/\d+$/)?.[0] ?? 60)
    );
  if (
    /^(PEER_FLOOD|USER_RESTRICTED|USER_DEACTIVATED|USER_DEACTIVATED_BAN|FROZEN_METHOD_INVALID|PHONE_NUMBER_BANNED)$/.test(
      code
    )
  )
    return new DeliveryError("restricted", code);
  if (
    /^(AUTH_KEY_UNREGISTERED|AUTH_KEY_DUPLICATED|SESSION_REVOKED|SESSION_EXPIRED|USER_BANNED_IN_CHANNEL)$/.test(
      code
    )
  )
    return new DeliveryError(
      code === "USER_BANNED_IN_CHANNEL" ? "recipient" : "auth",
      code
    );
  if (
    /^(MESSAGE_TOO_LONG|MESSAGE_EMPTY|ENTITY_BOUNDS_INVALID|ENTITIES_TOO_LONG)$/.test(
      code
    )
  )
    return new DeliveryError("content", code);
  return new Error("MTPROTO_RESULT_UNKNOWN");
}
async function sendBot(request: DeliveryRequest) {
  const settings = await getBotSettings(request.ownerId);
  if (!settings?.isValid) throw new DeliveryError("auth", "BOT_NOT_CONNECTED");
  if (
    !request.senderFingerprint ||
    request.senderFingerprint !==
      createHash("sha256").update(settings.botToken).digest("hex")
  )
    throw new DeliveryError("auth", "APPROVED_SENDER_CHANGED");
  if (request.recipient.startsWith("phone:"))
    throw new DeliveryError("recipient", "BOT_PHONE_NOT_ADDRESSABLE");
  const chat = request.recipient.startsWith("chat:")
    ? request.recipient.slice(5)
    : `@${request.recipient.slice(9)}`;
  const result = await telegramRequest(
    settings.botToken,
    "sendMessage",
    {
      chat_id: chat,
      text: request.message,
      ...(request.parseMode && request.parseMode !== "None"
        ? { parse_mode: request.parseMode }
        : {}),
      allow_paid_broadcast: false,
    },
    request.signal
  );
  if (!result.ok) throw classifyBotError(result);
  const message = result.result as { message_id?: unknown } | undefined;
  if (typeof message?.message_id !== "number")
    throw new Error("BOT_RESPONSE_UNCONFIRMED");
  return { messageId: String(message.message_id) };
}
async function sendMtproto(request: DeliveryRequest) {
  const session = await getMtprotoSession(request.ownerId);
  if (!session?.isActive || !session.sessionString)
    throw new DeliveryError("auth", "MTPROTO_NOT_CONNECTED");
  if (
    !request.senderFingerprint ||
    request.senderFingerprint !==
      createHash("sha256").update(session.sessionString).digest("hex")
  )
    throw new DeliveryError("auth", "APPROVED_SENDER_CHANGED");
  if (request.parseMode === "MarkdownV2")
    throw new DeliveryError("content", "MTPROTO_MARKDOWNV2_UNSUPPORTED");
  const { client } = await createClient(session.sessionString);
  let aborted = false;
  let rejectAbort: (reason: Error) => void = () => {};
  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  // Drain/disconnect the transport BEFORE allowing the engine to release its sender lock.
  const abort = () => {
    aborted = true;
    void client.destroy().then(
      () => rejectAbort(new Error("MTPROTO_ABORTED")),
      () => rejectAbort(new Error("MTPROTO_DISCONNECT_FAILED"))
    );
  };
  request.signal.addEventListener("abort", abort, { once: true });
  try {
    if (request.signal.aborted) throw new Error("MTPROTO_ABORTED");
    const operation = (async () => {
      await client.connect();
      if (aborted) throw new Error("MTPROTO_ABORTED");
      let target: string | ReturnType<typeof bigInt>;
      if (request.recipient.startsWith("chat:"))
        target = bigInt(request.recipient.slice(5));
      else if (request.recipient.startsWith("username:"))
        target = `@${request.recipient.slice(9)}`;
      else target = request.recipient.slice(6); // Existing contacts only; never import unknown phones.
      let peer: Api.TypeInputPeer;
      try {
        peer = await client.getInputEntity(target);
      } catch (e) {
        const classified = classifyMtprotoError(e);
        if (classified instanceof DeliveryError) throw classified;
        if (
          e instanceof Error &&
          /^Could not find the input entity|^Cannot find any entity/.test(
            e.message
          )
        )
          throw new DeliveryError("recipient", "MTPROTO_PEER_NOT_RESOLVED");
        throw new DeliveryError(
          "transient",
          "MTPROTO_RESOLUTION_UNAVAILABLE",
          60
        );
      }
      const [message, entities] = await _parseMessageText(
        client,
        request.message,
        request.parseMode === "HTML"
          ? "html"
          : request.parseMode === "Markdown"
            ? "markdown"
            : false
      );
      if (aborted || request.signal.aborted) throw new Error("MTPROTO_ABORTED");
      const response = await client.invoke(
        new Api.messages.SendMessage({
          peer,
          message,
          entities,
          randomId: bigInt(request.randomId),
          noWebpage: true,
        })
      );
      if (response instanceof Api.UpdateShortSentMessage)
        return { messageId: String(response.id) };
      if (
        response instanceof Api.Updates ||
        response instanceof Api.UpdatesCombined
      ) {
        const mapping = response.updates.find(
          (v): v is Api.UpdateMessageID =>
            v instanceof Api.UpdateMessageID &&
            v.randomId?.toString() === request.randomId
        );
        if (mapping) return { messageId: String(mapping.id) };
      }
      throw new Error("MTPROTO_RESPONSE_UNCONFIRMED");
    })();
    return await Promise.race([operation, abortPromise]);
  } catch (e) {
    if (e instanceof DeliveryError) throw e;
    throw classifyMtprotoError(e);
  } finally {
    request.signal.removeEventListener("abort", abort);
    await client.destroy();
  }
}
export const telegramTransport: DeliveryTransport = {
  send: async request => {
    if (process.env.LIVE_SEND_ENABLED !== "true")
      throw new DeliveryError("auth", "LIVE_SEND_DISABLED");
    return request.kind === "bot" ? sendBot(request) : sendMtproto(request);
  },
};
