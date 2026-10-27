import { Api, type TelegramClient } from "telegram";
import bigInt from "big-integer";
import { createHash, randomBytes } from "node:crypto";
import { _parseMessageText } from "telegram/client/messageParse.js";
import { getBotSettings, getMtprotoSession } from "./db";
import { createClient } from "./mtproto";
import { getPhotoBytes } from "./media";
import { getTelegramWait } from "./telegramWait";
import { PHOTO_CAPTION_MAX_LENGTH, PHOTO_MAX_BYTES } from "../shared/media";
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
      // Workers support manual/follow; never follow a credential-bearing redirect.
      redirect: "manual",
    }
  );
  if (response.status >= 300 && response.status < 400)
    throw new Error("TELEGRAM_RESPONSE_UNKNOWN");
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
  const wait = getTelegramWait(error);
  if (wait) return new DeliveryError(wait.category, wait.code, wait.seconds);
  const e = error as { errorMessage?: string; seconds?: number };
  const code = e?.errorMessage;
  if (!code) return new Error("MTPROTO_RESULT_UNKNOWN");
  if (
    /^INPUT_USER_DEACTIVATED$|^USER_PRIVACY_RESTRICTED$|^USER_IS_BLOCKED$|^YOU_BLOCKED_USER$|^PEER_ID_INVALID$|^USERNAME_NOT_OCCUPIED$|^PHONE_NOT_OCCUPIED$|^PHONE_NUMBER_INVALID$|^USERNAME_INVALID$|^CHAT_WRITE_FORBIDDEN$/.test(
      code
    )
  )
    return new DeliveryError("recipient", code);
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
    /^(MESSAGE_TOO_LONG|MESSAGE_EMPTY|ENTITY_BOUNDS_INVALID|ENTITIES_TOO_LONG|MEDIA_CAPTION_TOO_LONG|MEDIA_EMPTY|MEDIA_INVALID|PHOTO_INVALID|PHOTO_INVALID_DIMENSIONS|PHOTO_EXT_INVALID|IMAGE_PROCESS_FAILED|FILE_PARTS_INVALID|FILE_PART_TOO_BIG|FILE_PART_SIZE_INVALID|FILE_PART_EMPTY|FILE_PART_MISSING)$/.test(
      code
    )
  )
    return new DeliveryError("content", code);
  return new Error("MTPROTO_RESULT_UNKNOWN");
}

const UPLOAD_DIAGNOSTIC_RPC_CODES = new Set([
  "PHONE_NOT_OCCUPIED",
  "PHONE_NUMBER_INVALID",
  "PHONE_NUMBER_BANNED",
  "USER_PRIVACY_RESTRICTED",
  "USER_IS_BLOCKED",
  "YOU_BLOCKED_USER",
  "INPUT_USER_DEACTIVATED",
  "PEER_ID_INVALID",
  "USER_RESTRICTED",
  "FILE_PART_EMPTY",
  "FILE_PART_INVALID",
  "FILE_PART_SIZE_INVALID",
  "FILE_PART_TOO_BIG",
  "FILE_PARTS_INVALID",
  "FILE_ID_INVALID",
  "MSG_ID_INVALID",
  "AUTH_KEY_UNREGISTERED",
  "AUTH_KEY_DUPLICATED",
  "SESSION_REVOKED",
  "SESSION_EXPIRED",
  "USER_DEACTIVATED",
  "USER_DEACTIVATED_BAN",
  "FROZEN_METHOD_INVALID",
  "PEER_FLOOD",
  "RPC_CALL_FAIL",
  "RPC_MCGET_FAIL",
  "CONNECTION_NOT_INITED",
  "CONNECTION_LAYER_INVALID",
  "INPUT_LAYER_INVALID",
  "METHOD_INVALID",
]);
const UPLOAD_DIAGNOSTIC_SYSTEM_CODES = new Set([
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "ERR_INVALID_ARG_TYPE",
  "ERR_OUT_OF_RANGE",
  "ERR_NOT_IMPLEMENTED",
  "ERR_METHOD_NOT_IMPLEMENTED",
  "ERR_STREAM_PREMATURE_CLOSE",
  "ERR_STREAM_DESTROYED",
  "ERR_SOCKET_CLOSED",
]);
const UPLOAD_DIAGNOSTIC_NAMES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "CastError",
  "RPCError",
  "BadRequestError",
  "UnauthorizedError",
  "ForbiddenError",
  "AuthKeyError",
  "ServerError",
  "TimedOutError",
  "FileMigrateError",
  "FloodWaitError",
  "FloodTestPhoneWaitError",
  "SlowModeWaitError",
  "TimeoutError",
  "AbortError",
  "QuotaExceededError",
]);
const UPLOAD_DIAGNOSTIC_FIXED_MESSAGES = new Map([
  ["Maximum reconnection retries reached. Aborting!", "RECONNECT_EXHAUSTED"],
  ["NetSocket was closed", "SOCKET_CLOSED"],
  ["Not connected", "TRANSPORT_DISCONNECTED"],
  ["Auth key unset", "AUTH_KEY_UNSET"],
  ["Auth key not set", "AUTH_KEY_UNSET"],
  ["Unset AuthKey", "AUTH_KEY_UNSET"],
  ["Not a valid string", "INVALID_SESSION_FORMAT"],
  ["MTPROTO_ABORTED", "DISPATCH_ABORTED"],
  ["MTPROTO_DISCONNECT_FAILED", "DISCONNECT_FAILED"],
]);

/** Fixed metadata only: raw exceptions may contain request bytes and credentials. */
export function photoUploadFailureDiagnostic(error: unknown) {
  let reason: string = getTelegramWait(error)?.code ?? "UNKNOWN";
  let name = "UNKNOWN";
  try {
    const problem = error as {
      errorMessage?: unknown;
      code?: unknown;
      name?: unknown;
    } | null;
    const rpc = problem?.errorMessage;
    if (reason === "UNKNOWN" && typeof rpc === "string") {
      if (UPLOAD_DIAGNOSTIC_RPC_CODES.has(rpc)) reason = rpc;
      else if (/^FLOOD_(?:PREMIUM_)?WAIT(?:_\d+)?$/.test(rpc))
        reason = "FLOOD_WAIT";
      else if (/^FILE_MIGRATE_\d+$/.test(rpc)) reason = "FILE_MIGRATE";
      else if (/^FILE_PART_\d+_MISSING$/.test(rpc))
        reason = "FILE_PART_MISSING";
    }
    if (
      reason === "UNKNOWN" &&
      typeof problem?.code === "string" &&
      UPLOAD_DIAGNOSTIC_SYSTEM_CODES.has(problem.code)
    )
      reason = problem.code;
    if (
      reason === "UNKNOWN" &&
      error instanceof Error &&
      error.message === "Request was unsuccessful 1 time(s)"
    )
      reason = "SDK_RETRY_EXHAUSTED";
    if (reason === "UNKNOWN") {
      const fixedMessage =
        typeof error === "string"
          ? error
          : error instanceof Error
            ? error.message
            : undefined;
      if (fixedMessage !== undefined)
        reason = UPLOAD_DIAGNOSTIC_FIXED_MESSAGES.get(fixedMessage) ?? reason;
    }
    if (
      typeof problem?.name === "string" &&
      UPLOAD_DIAGNOSTIC_NAMES.has(problem.name)
    )
      name = problem.name;
  } catch {
    // Malformed metadata/getters must not make error reporting throw.
  }
  return {
    event: "telegram_media_failure",
    stage: "upload_part",
    reason,
    name,
  } as const;
}

export function phoneResolutionFailureDiagnostic(
  stage: "connect" | "resolve_phone",
  error: unknown
) {
  const { reason, name } = photoUploadFailureDiagnostic(error);
  return {
    event: "telegram_phone_resolution_failure",
    stage,
    reason,
    name,
  } as const;
}

async function sendBot(request: DeliveryRequest) {
  if (request.photoId || request.photoSha256)
    throw new DeliveryError("content", "BOT_PHOTO_UNSUPPORTED");
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

async function loadApprovedPhoto(request: DeliveryRequest) {
  if (!request.photoId) {
    if (request.photoSha256)
      throw new DeliveryError("content", "PHOTO_ATTACHMENT_CHANGED");
    return undefined;
  }
  if (!request.photoSha256)
    throw new DeliveryError("content", "PHOTO_ATTACHMENT_CHANGED");
  if (request.message.length > PHOTO_CAPTION_MAX_LENGTH)
    throw new DeliveryError("content", "MEDIA_CAPTION_TOO_LONG");
  let photo: Awaited<ReturnType<typeof getPhotoBytes>>;
  try {
    photo = await getPhotoBytes(request.ownerId, request.photoId);
  } catch (error) {
    const code = (error as { code?: string })?.code;
    const unavailable =
      code === "NOT_FOUND" ||
      code === "BAD_REQUEST" ||
      (error instanceof Error &&
        /^(PHOTO_CONTENT_UNAVAILABLE|PHOTO_INTEGRITY_FAILED)$/.test(
          error.message
        ));
    throw new DeliveryError(
      unavailable ? "content" : "transient",
      unavailable ? "PHOTO_UNAVAILABLE" : "PHOTO_LOAD_UNAVAILABLE",
      60
    );
  }
  if (
    !photo.bytes.length ||
    photo.bytes.length > PHOTO_MAX_BYTES ||
    photo.attachment.size !== photo.bytes.length ||
    photo.attachment.sha256 !== request.photoSha256 ||
    createHash("sha256").update(photo.bytes).digest("hex") !==
      request.photoSha256
  )
    throw new DeliveryError("content", "PHOTO_ATTACHMENT_CHANGED");
  return photo;
}

async function uploadPhoto(
  client: TelegramClient,
  photo: NonNullable<Awaited<ReturnType<typeof loadApprovedPhoto>>>,
  ensureActive: () => void
): Promise<Api.InputMediaUploadedPhoto> {
  // Avoid GramJS uploadFile/sendFile: their upload retry loop may sleep through
  // an abort, and sendFile creates a different logical-message randomId.
  // Native Workers probes accepted 32 KiB parts; 128 KiB encoded correctly but
  // disconnected during upload. Keep the size verified on the deployed runtime.
  const partSize = 32 * 1024;
  const parts = Math.ceil(photo.bytes.length / partSize);
  const fileId = bigInt(
    (randomBytes(8).readBigUInt64BE() & 0x7fffffffffffffffn || 1n).toString()
  );
  for (let part = 0; part < parts; part++) {
    ensureActive();
    let accepted: boolean;
    try {
      accepted = await client.invoke(
        new Api.upload.SaveFilePart({
          fileId,
          filePart: part,
          bytes: photo.bytes.subarray(part * partSize, (part + 1) * partSize),
        })
      );
    } catch (error) {
      ensureActive();
      console.warn(JSON.stringify(photoUploadFailureDiagnostic(error)));
      const classified = classifyMtprotoError(error);
      if (classified instanceof DeliveryError) throw classified;
      // No messages.SendMedia has been issued, so this failure is safe to retry.
      throw new DeliveryError("transient", "PHOTO_UPLOAD_UNAVAILABLE", 60);
    }
    ensureActive();
    if (!accepted)
      throw new DeliveryError("transient", "PHOTO_UPLOAD_REJECTED", 60);
  }
  return new Api.InputMediaUploadedPhoto({
    file: new Api.InputFile({
      id: fileId,
      parts,
      name:
        photo.attachment.mimeType === "image/png" ? "photo.png" : "photo.jpg",
      md5Checksum: createHash("md5").update(photo.bytes).digest("hex"),
    }),
  });
}

async function resolvePhonePeer(
  client: TelegramClient,
  phone: string,
  ensureActive: () => void
): Promise<Api.TypeInputPeer> {
  if (!/^\+[1-9]\d{6,14}$/.test(phone))
    throw new DeliveryError("recipient", "PHONE_NUMBER_INVALID");
  ensureActive();
  // This official lookup respects the recipient's phone-discovery privacy and
  // does not import, add, or remove anything from the sender's contact book.
  const resolved = await client.invoke(
    new Api.contacts.ResolvePhone({ phone })
  );
  ensureActive();
  if (
    !(resolved instanceof Api.contacts.ResolvedPeer) ||
    !(resolved.peer instanceof Api.PeerUser) ||
    !bigInt.isInstance(resolved.peer.userId) ||
    resolved.peer.userId.lesserOrEquals(0) ||
    !Array.isArray(resolved.users)
  )
    throw new DeliveryError("recipient", "MTPROTO_PHONE_NOT_RESOLVED");
  const peerId = resolved.peer.userId.toString();
  const user = resolved.users.find(
    (candidate): candidate is Api.User =>
      candidate instanceof Api.User &&
      bigInt.isInstance(candidate.id) &&
      candidate.id.toString() === peerId
  );
  if (!user || user.deleted || user.min)
    throw new DeliveryError("recipient", "MTPROTO_PHONE_NOT_RESOLVED");
  if (user.self) return new Api.InputPeerSelf();
  if (
    user.accessHash === undefined ||
    user.accessHash === null ||
    !bigInt.isInstance(user.accessHash) ||
    user.accessHash.isZero()
  )
    throw new DeliveryError("recipient", "MTPROTO_PHONE_ACCESS_HASH_MISSING");
  return new Api.InputPeerUser({
    userId: user.id,
    accessHash: user.accessHash,
  });
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
  const photo = await loadApprovedPhoto(request);
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
  const ensureActive = () => {
    if (aborted || request.signal.aborted) throw new Error("MTPROTO_ABORTED");
  };
  let phoneStage: "connect" | "resolve_phone" | undefined;
  const reportPhoneFailure = (error: unknown) => {
    if (!phoneStage) return;
    const stage = phoneStage;
    phoneStage = undefined;
    console.warn(
      JSON.stringify(phoneResolutionFailureDiagnostic(stage, error))
    );
  };
  try {
    ensureActive();
    const operation = (async () => {
      if (request.recipient.startsWith("phone:")) phoneStage = "connect";
      await client.connect();
      ensureActive();
      let peer: Api.TypeInputPeer;
      try {
        if (request.recipient.startsWith("phone:")) {
          phoneStage = "resolve_phone";
          peer = await resolvePhonePeer(
            client,
            request.recipient.slice(6),
            ensureActive
          );
          phoneStage = undefined;
        } else {
          const target = request.recipient.startsWith("chat:")
            ? bigInt(request.recipient.slice(5))
            : `@${request.recipient.slice(9)}`;
          peer = await client.getInputEntity(target);
        }
      } catch (e) {
        reportPhoneFailure(e);
        ensureActive();
        if (e instanceof DeliveryError) throw e;
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
      ensureActive();
      if (photo && message.length > PHOTO_CAPTION_MAX_LENGTH)
        throw new DeliveryError("content", "MEDIA_CAPTION_TOO_LONG");
      const media = photo
        ? await uploadPhoto(client, photo, ensureActive)
        : undefined;
      ensureActive();
      const response = await client.invoke(
        media
          ? new Api.messages.SendMedia({
              peer,
              media,
              message,
              entities,
              randomId: bigInt(request.randomId),
            })
          : new Api.messages.SendMessage({
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
    reportPhoneFailure(e);
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
