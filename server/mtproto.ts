/** Short-lived MTProto authentication. Delivery clients are owned by the worker. */
import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Logger, LogLevel } from "telegram/extensions/Logger.js";
import { TRPCError } from "@trpc/server";
import type { PoolClient } from "pg";
import { getPool } from "./connection";
import { getMtprotoSession } from "./db";
import { decryptSecret, encryptSecret } from "./security/secrets";
import { LOGIN_PHONE_ERROR, normalizeLoginPhone } from "../shared/loginPhone";
import { getTelegramWait } from "./telegramWait";
import type {
  LoginCodeDelivery,
  MtprotoAuthStatus,
} from "../shared/authStatus";

export interface MtprotoClientInfo {
  client: TelegramClient;
  session: StringSession;
}
interface PendingAuth {
  sessionString: string;
  phoneCodeHash: string;
  phone: string;
  expiresAt: number;
  attempts: number;
  needsPassword: boolean;
  delivery?: LoginCodeDelivery;
  codeLength?: number | null;
}
interface SignInResult {
  sessionString: string;
  user: {
    id: string;
    firstName: string;
    lastName: string;
    username: string;
    phone: string;
  };
}
type CommitAuth = (result: SignInResult, client: PoolClient) => Promise<void>;
const AUTH_TTL_MS = 5 * 60 * 1000;
const AUTH_TIMEOUT_MS = 20_000;
const CODE_REQUEST_WINDOW_MS = 15 * 60 * 1000;
const MAX_CODE_REQUESTS = 3;

export function getApiCredentials() {
  const rawId = process.env.TELEGRAM_API_ID ?? "";
  const apiId = Number(rawId);
  const apiHash = process.env.TELEGRAM_API_HASH ?? "";
  if (
    !/^\d+$/.test(rawId) ||
    !Number.isSafeInteger(apiId) ||
    apiId <= 0 ||
    !/^[a-fA-F0-9]{32}$/.test(apiHash)
  ) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "Укажите собственные TELEGRAM_API_ID и TELEGRAM_API_HASH в настройках сервера.",
    });
  }
  return { apiId, apiHash };
}

export async function createClient(
  sessionString = ""
): Promise<MtprotoClientInfo> {
  const { apiId, apiHash } = getApiCredentials();
  const session = new StringSession(sessionString);
  const client = new TelegramClient(session, apiId, apiHash, {
    requestRetries: 1,
    connectionRetries: 1,
    reconnectRetries: 0,
    autoReconnect: false,
    floodSleepThreshold: 0,
    useWSS: false,
    baseLogger: new Logger(LogLevel.NONE),
  });
  client.onError = async () => {
    /* Never forward raw Telegram auth exceptions to logs. */
  };
  return { client, session };
}

async function destroyClient(client: TelegramClient) {
  await client.destroy().catch(() => {});
}

async function disposePending(tx: PoolClient, userId: number) {
  await tx.query("DELETE FROM mtproto_pending_auth WHERE user_id=$1", [userId]);
}

async function serializedAuth<T>(
  userId: number,
  operation: (tx: PoolClient, discardConnection: () => void) => Promise<T>
): Promise<T> {
  if (!Number.isSafeInteger(userId) || userId <= 0)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Некорректный владелец",
    });
  // Keep a dedicated session: transaction pooling would release this barrier
  // before Telegram responds and permit concurrent auth in another isolate.
  const tx = await getPool().connect();
  const key = `tg-sender:mtproto-auth:${userId}`;
  let locked = false;
  let broken = false;
  const connectionError = () => {
    broken = true;
  };
  tx.on("error", connectionError);
  try {
    const lock = await tx.query(
      "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired",
      [key]
    );
    if (!lock.rows[0]?.acquired)
      throw new TRPCError({
        code: "CONFLICT",
        message: "Дождитесь завершения текущего запроса входа.",
      });
    locked = true;
    // Expiry is enforced by the database, not a timer in a previous request.
    await tx.query("DELETE FROM mtproto_pending_auth WHERE expires_at<=now()");
    return await operation(tx, connectionError);
  } finally {
    if (locked && !broken)
      await tx
        .query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [key])
        .catch(() => {
          broken = true;
        });
    tx.removeListener("error", connectionError);
    tx.release(broken);
  }
}

async function bounded<T>(
  client: TelegramClient,
  work: (ensureActive: () => void) => Promise<T>
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeoutError = () =>
    new TRPCError({
      code: "TIMEOUT",
      message:
        "Telegram не ответил вовремя. Запрос не повторялся автоматически.",
    });
  const ensureActive = () => {
    if (timedOut) throw timeoutError();
  };
  try {
    return await Promise.race([
      work(ensureActive),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          void destroyClient(client);
          reject(timeoutError());
        }, AUTH_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function errorForAuth(
  tx: PoolClient,
  userId: number,
  error: unknown
): Promise<TRPCError> {
  if (error instanceof TRPCError) return error;
  const problem = error as {
    errorMessage?: string;
    seconds?: number;
    code?: string;
  };
  const code = problem?.errorMessage ?? "";
  const wait = getTelegramWait(error);
  if (wait) {
    await tx.query(
      `UPDATE mtproto_auth_controls SET next_code_at=GREATEST(next_code_at,now()+$2*interval '1 second') WHERE user_id=$1`,
      [userId, wait.seconds]
    );
    return new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: `Telegram требует паузу ${wait.seconds} сек. Автоматический повтор отключён.`,
    });
  }
  if (
    [
      "ETIMEDOUT",
      "ECONNRESET",
      "ECONNREFUSED",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "EAI_AGAIN",
      "ENOTFOUND",
    ].includes(problem?.code ?? "")
  )
    return new TRPCError({
      code: "SERVICE_UNAVAILABLE",
      message:
        "Не удалось соединиться с Telegram. Проверьте состояние сервиса и повторите позже.",
    });
  const messages: Record<string, string> = {
    API_ID_INVALID:
      "Telegram отклонил API ID или API Hash. Проверьте настройки приложения Telegram.",
    API_ID_PUBLISHED_FLOOD:
      "Telegram ограничил API ID этого приложения. Проверьте его в my.telegram.org.",
    APP_VERSION_OUTDATED:
      "Telegram требует обновить клиент. Сообщите об ошибке администратору сервиса.",
    UPDATE_APP_TO_LOGIN:
      "Telegram требует обновить клиент. Сообщите об ошибке администратору сервиса.",
    PHONE_CODE_INVALID: "Неверный код Telegram.",
    PHONE_CODE_EMPTY: "Введите код Telegram.",
    PHONE_CODE_EXPIRED: "Код Telegram истёк. Запросите новый код.",
    PASSWORD_HASH_INVALID: "Неверный пароль двухэтапной проверки.",
    PHONE_NUMBER_INVALID: "Некорректный номер телефона.",
    PHONE_NUMBER_BANNED:
      "Telegram ограничил этот номер. Проверьте статус аккаунта.",
    PHONE_NUMBER_FLOOD: "Telegram ограничил запросы кода. Повторите позже.",
    PHONE_PASSWORD_FLOOD:
      "Telegram временно ограничил попытки входа. Повторите позже.",
    AUTH_RESTART: "Telegram завершил попытку входа. Запросите новый код.",
  };
  return new TRPCError({
    code: "BAD_REQUEST",
    message:
      messages[code] ??
      "Не удалось выполнить вход в Telegram. Проверьте подключение и начните вход заново.",
  });
}

function validPendingAuth(value: unknown, now: number): value is PendingAuth {
  if (!value || typeof value !== "object") return false;
  const state = value as PendingAuth;
  return (
    typeof state.sessionString === "string" &&
    !!state.sessionString &&
    typeof state.phoneCodeHash === "string" &&
    !!state.phoneCodeHash &&
    typeof state.phone === "string" &&
    /^\+[1-9]\d{6,14}$/.test(state.phone) &&
    Number.isFinite(state.expiresAt) &&
    state.expiresAt > now &&
    Number.isInteger(state.attempts) &&
    state.attempts >= 0 &&
    state.attempts < 5 &&
    typeof state.needsPassword === "boolean"
  );
}

async function readAuthStatus(
  query: Pick<PoolClient, "query">,
  userId: number
): Promise<MtprotoAuthStatus> {
  const result = await query.query(
    `SELECT now() AS server_now,c.sent_count,c.window_started_at,c.next_code_at,
            p.payload_encrypted,p.expires_at AS pending_expires_at
       FROM (SELECT $1::integer AS user_id) owner
       LEFT JOIN mtproto_auth_controls c ON c.user_id=owner.user_id
       LEFT JOIN mtproto_pending_auth p ON p.user_id=owner.user_id`,
    [userId]
  );
  const row = result.rows[0] ?? {};
  const now = new Date(row.server_now ?? Date.now()).getTime();
  const windowEndsAt =
    new Date(row.window_started_at ?? 0).getTime() + CODE_REQUEST_WINDOW_MS;
  const count =
    windowEndsAt > now ? Math.max(0, Number(row.sent_count) || 0) : 0;
  const retryAt = Math.max(
    now,
    new Date(row.next_code_at ?? 0).getTime(),
    count >= MAX_CODE_REQUESTS ? windowEndsAt : 0
  );
  let pending: MtprotoAuthStatus["pending"] = null;
  if (
    row.payload_encrypted &&
    new Date(row.pending_expires_at).getTime() > now
  ) {
    try {
      const state: unknown = JSON.parse(
        decryptSecret(row.payload_encrypted, `mtproto-auth:${userId}`)
      );
      if (validPendingAuth(state, now)) {
        const knownDelivery = ["telegram", "sms", "call", "email"];
        pending = {
          step: state.needsPassword ? "password" : "code",
          maskedPhone: `${state.phone.slice(0, 3)}${"•".repeat(state.phone.length - 5)}${state.phone.slice(-2)}`,
          expiresAt: new Date(
            Math.min(
              state.expiresAt,
              new Date(row.pending_expires_at).getTime()
            )
          ).toISOString(),
          codeAttemptsRemaining: 5 - state.attempts,
          delivery: knownDelivery.includes(state.delivery ?? "")
            ? state.delivery!
            : "unknown",
          codeLength:
            Number.isInteger(state.codeLength) &&
            state.codeLength! >= 4 &&
            state.codeLength! <= 8
              ? state.codeLength!
              : null,
        };
      }
    } catch {
      // A status read must neither expose invalid ciphertext nor consume attempts.
    }
  }
  return {
    serverNow: new Date(now).toISOString(),
    retryAt: retryAt > now ? new Date(retryAt).toISOString() : null,
    attemptsRemaining: Math.max(0, MAX_CODE_REQUESTS - count),
    pending,
  };
}

export async function getAuthStatus(
  userId: number
): Promise<MtprotoAuthStatus> {
  if (!Number.isSafeInteger(userId) || userId <= 0)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Некорректный владелец",
    });
  return readAuthStatus(getPool(), userId);
}

async function assertCodeRequestAllowed(tx: PoolClient, userId: number) {
  const status = await readAuthStatus(tx, userId);
  if (!status.retryAt) return;
  const seconds = Math.ceil(
    (Date.parse(status.retryAt) - Date.parse(status.serverNow)) / 1000
  );
  throw new TRPCError({
    code: "TOO_MANY_REQUESTS",
    message: `Следующий код можно запросить через ${seconds} сек. Если код уже пришёл, продолжите его ввод.`,
  });
}

function validDataCenter(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 5;
}

async function sendCodeFollowingRedirect(
  client: TelegramClient,
  session: StringSession,
  request: Api.auth.SendCode,
  ensureActive: () => void
) {
  const originalDc = session.dcId;
  try {
    return await client.invoke(request);
  } catch (error) {
    // GramJS with requestRetries=1 completes a 303 DC migration, then exits its
    // loop before sending the request to the new DC. Correct only that proven
    // redirect; timeouts, flood waits and unknown outcomes are never retried.
    if (
      !(error instanceof Error) ||
      error.message !== "Request was unsuccessful 1 time(s)" ||
      !validDataCenter(originalDc) ||
      !validDataCenter(session.dcId) ||
      session.dcId === originalDc
    )
      throw error;
    ensureActive();
    return client.invoke(request);
  }
}

function codeDelivery(result: Api.auth.SentCode): LoginCodeDelivery {
  const name = result.type?.className;
  if (name === "auth.SentCodeTypeApp") return "telegram";
  if (name === "auth.SentCodeTypeEmailCode") return "email";
  if (
    [
      "auth.SentCodeTypeSms",
      "auth.SentCodeTypeSmsWord",
      "auth.SentCodeTypeSmsPhrase",
    ].includes(name)
  )
    return "sms";
  if (
    [
      "auth.SentCodeTypeCall",
      "auth.SentCodeTypeFlashCall",
      "auth.SentCodeTypeMissedCall",
    ].includes(name)
  )
    return "call";
  return "unknown";
}

function codeLength(result: Api.auth.SentCode): number | null {
  const length = (result.type as { length?: unknown } | undefined)?.length;
  return typeof length === "number" &&
    Number.isInteger(length) &&
    length >= 4 &&
    length <= 8
    ? length
    : null;
}

async function pendingForResume(
  tx: PoolClient,
  userId: number
): Promise<PendingAuth | null> {
  const result = await tx.query(
    "SELECT payload_encrypted FROM mtproto_pending_auth WHERE user_id=$1 AND expires_at>now()",
    [userId]
  );
  if (!result.rows[0]) return null;
  try {
    const value: unknown = JSON.parse(
      decryptSecret(result.rows[0].payload_encrypted, `mtproto-auth:${userId}`)
    );
    return validPendingAuth(value, Date.now()) ? value : null;
  } catch {
    return null;
  }
}

async function claimCodeRequest(tx: PoolClient, userId: number) {
  const result = await tx.query(
    `INSERT INTO mtproto_auth_controls(user_id,sent_count,window_started_at,next_code_at)
    VALUES($1,1,now(),now()+interval '60 seconds') ON CONFLICT(user_id) DO UPDATE SET
      sent_count=CASE WHEN mtproto_auth_controls.window_started_at<now()-interval '15 minutes' THEN 1 ELSE mtproto_auth_controls.sent_count+1 END,
      window_started_at=CASE WHEN mtproto_auth_controls.window_started_at<now()-interval '15 minutes' THEN now() ELSE mtproto_auth_controls.window_started_at END,
      next_code_at=now()+interval '60 seconds'
    WHERE mtproto_auth_controls.next_code_at<=now() AND (mtproto_auth_controls.window_started_at<now()-interval '15 minutes' OR mtproto_auth_controls.sent_count<3)
    RETURNING user_id`,
    [userId]
  );
  if (!result.rowCount)
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message:
        "Код уже запрошен. Подождите; разрешено не более трёх запросов за 15 минут.",
    });
}

function authFailureReason(error: unknown): string {
  const wait = getTelegramWait(error);
  if (wait) return wait.code;
  const problem = error as { errorMessage?: unknown; code?: unknown } | null;
  const rpcCodes = new Set([
    "API_ID_INVALID",
    "API_ID_PUBLISHED_FLOOD",
    "APP_VERSION_OUTDATED",
    "UPDATE_APP_TO_LOGIN",
    "PHONE_NUMBER_INVALID",
    "PHONE_NUMBER_BANNED",
    "PHONE_NUMBER_FLOOD",
    "PHONE_PASSWORD_FLOOD",
    "PHONE_PASSWORD_PROTECTED",
    "PHONE_NUMBER_APP_SIGNUP_FORBIDDEN",
    "SMS_CODE_CREATE_FAILED",
    "AUTH_RESTART",
  ]);
  if (typeof problem?.errorMessage === "string") {
    if (rpcCodes.has(problem.errorMessage)) return problem.errorMessage;
    if (/^FLOOD_WAIT(?:_\d+)?$/.test(problem.errorMessage)) return "FLOOD_WAIT";
  }
  const networkCodes = new Set([
    "ETIMEDOUT",
    "ECONNRESET",
    "ECONNREFUSED",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "EAI_AGAIN",
    "ENOTFOUND",
  ]);
  if (typeof problem?.code === "string" && networkCodes.has(problem.code))
    return problem.code;
  if (error instanceof TRPCError && error.code === "TIMEOUT") return "TIMEOUT";
  if (
    error instanceof Error &&
    error.message === "Request was unsuccessful 1 time(s)"
  )
    return "SDK_RETRY_EXHAUSTED";
  return "UNKNOWN";
}

export async function sendPhoneCode(
  userId: number,
  phone: string,
  resend = false
): Promise<{ phoneCodeHash: string; reused?: true }> {
  const normalizedPhone = normalizeLoginPhone(phone);
  if (normalizedPhone === null)
    throw new TRPCError({ code: "BAD_REQUEST", message: LOGIN_PHONE_ERROR });
  return serializedAuth(userId, async tx => {
    const credentials = getApiCredentials();
    if (!resend) {
      const pending = await pendingForResume(tx, userId);
      if (pending?.phone === normalizedPhone)
        return { phoneCodeHash: pending.phoneCodeHash, reused: true };
    }
    await assertCodeRequestAllowed(tx, userId);
    const { client, session } = await createClient();
    let codeRequested = false;
    try {
      const result = await bounded(client, async ensureActive => {
        await client.connect();
        ensureActive();
        await claimCodeRequest(tx, userId);
        ensureActive();
        await disposePending(tx, userId);
        ensureActive();
        codeRequested = true;
        return sendCodeFollowingRedirect(
          client,
          session,
          new Api.auth.SendCode({
            phoneNumber: normalizedPhone,
            ...credentials,
            settings: new Api.CodeSettings({}),
          }),
          ensureActive
        );
      });
      const phoneCodeHash = (result as Api.auth.SentCode).phoneCodeHash;
      if (!phoneCodeHash) throw new Error("UNEXPECTED_AUTH_RESULT");
      const state: PendingAuth = {
        phoneCodeHash,
        phone: normalizedPhone,
        sessionString: session.save() as unknown as string,
        expiresAt: Date.now() + AUTH_TTL_MS,
        attempts: 0,
        needsPassword: false,
        delivery: codeDelivery(result as Api.auth.SentCode),
        codeLength: codeLength(result as Api.auth.SentCode),
      };
      await tx.query(
        `INSERT INTO mtproto_pending_auth(user_id,payload_encrypted,expires_at)
         VALUES($1,$2,to_timestamp($3::double precision/1000))`,
        [
          userId,
          encryptSecret(JSON.stringify(state), `mtproto-auth:${userId}`),
          state.expiresAt,
        ]
      );
      return { phoneCodeHash };
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "telegram_auth_failure",
          stage: codeRequested ? "request_code" : "connect",
          reason: authFailureReason(error),
        })
      );
      if (codeRequested) await disposePending(tx, userId);
      throw await errorForAuth(tx, userId, error);
    } finally {
      await destroyClient(client);
    }
  });
}

async function persistPending(
  tx: PoolClient,
  userId: number,
  state: PendingAuth
) {
  const result = await tx.query(
    `UPDATE mtproto_pending_auth SET payload_encrypted=$2,updated_at=now()
     WHERE user_id=$1 AND expires_at>now() RETURNING user_id`,
    [userId, encryptSecret(JSON.stringify(state), `mtproto-auth:${userId}`)]
  );
  if (!result.rowCount) throw expiredAuth();
}

function expiredAuth() {
  return new TRPCError({
    code: "BAD_REQUEST",
    message: "Попытка входа истекла или исчерпана. Запросите новый код.",
  });
}

async function requirePending(
  tx: PoolClient,
  userId: number
): Promise<PendingAuth> {
  const result = await tx.query(
    "SELECT payload_encrypted FROM mtproto_pending_auth WHERE user_id=$1 AND expires_at>now()",
    [userId]
  );
  let state: PendingAuth | undefined;
  try {
    if (result.rows[0])
      state = JSON.parse(
        decryptSecret(
          result.rows[0].payload_encrypted,
          `mtproto-auth:${userId}`
        )
      );
  } catch {
    /* Invalid ciphertext or an old key must not expose raw credentials. */
  }
  if (!validPendingAuth(state, Date.now())) {
    await disposePending(tx, userId);
    throw expiredAuth();
  }
  // Claim an attempt before any outbound operation. A terminated invocation
  // cannot restore its attempt budget by leaving memory behind.
  state.attempts++;
  await persistPending(tx, userId, state);
  return state;
}

async function completeAuth(
  tx: PoolClient,
  userId: number,
  state: PendingAuth,
  info: MtprotoClientInfo,
  commit?: CommitAuth
): Promise<SignInResult> {
  const me = (await bounded(info.client, () =>
    info.client.getMe()
  )) as Api.User;
  // Also check database expiry after network I/O: a delayed reply cannot revive
  // an expired authorization attempt.
  const live = await tx.query(
    "SELECT user_id FROM mtproto_pending_auth WHERE user_id=$1 AND expires_at>now()",
    [userId]
  );
  if (!live.rowCount || state.expiresAt <= Date.now()) {
    await disposePending(tx, userId);
    throw expiredAuth();
  }
  const sessionString = info.session.save() as unknown as string;
  const result = {
    sessionString,
    user: {
      id: me.id.toString(),
      firstName: me.firstName ?? "",
      lastName: me.lastName ?? "",
      username: me.username ?? "",
      phone: me.phone ?? state.phone,
    },
  };
  // Router credential writes must finish before releasing the auth barrier;
  // otherwise a concurrent logout could be followed by a stale login commit.
  // Any commit failure is handled by the caller's fail-closed cleanup.
  await commit?.(result, tx);
  await disposePending(tx, userId);
  return result;
}

async function handleSignInError(
  tx: PoolClient,
  userId: number,
  state: PendingAuth,
  info: MtprotoClientInfo,
  error: unknown
): Promise<never> {
  const code = (error as { errorMessage?: string })?.errorMessage ?? "";
  if (
    state.attempts >= 5 ||
    ![
      "PHONE_CODE_INVALID",
      "PHONE_CODE_EMPTY",
      "PASSWORD_HASH_INVALID",
    ].includes(code)
  ) {
    await disposePending(tx, userId);
  } else {
    state.sessionString = info.session.save() as unknown as string;
    await persistPending(tx, userId, state);
  }
  throw await errorForAuth(tx, userId, error);
}

export async function signInWithCode(
  userId: number,
  code: string,
  commit?: CommitAuth
): Promise<SignInResult> {
  return serializedAuth(userId, async tx => {
    const state = await requirePending(tx, userId);
    let info: MtprotoClientInfo | undefined;
    try {
      if (!/^\d{4,8}$/.test(code))
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Введите код из сообщения Telegram.",
        });
      info = await createClient(state.sessionString);
      const active = info;
      try {
        await bounded(active.client, async ensureActive => {
          await active.client.connect();
          ensureActive();
          return active.client.invoke(
            new Api.auth.SignIn({
              phoneNumber: state.phone,
              phoneCodeHash: state.phoneCodeHash,
              phoneCode: code,
            })
          );
        });
      } catch (error) {
        if (
          (error as { errorMessage?: string })?.errorMessage ===
          "SESSION_PASSWORD_NEEDED"
        ) {
          state.needsPassword = true;
          state.sessionString = active.session.save() as unknown as string;
          await persistPending(tx, userId, state);
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "TWO_FACTOR_REQUIRED",
          });
        }
        throw error;
      }
      return await completeAuth(tx, userId, state, active, commit);
    } catch (error) {
      if (error instanceof TRPCError && error.message === "TWO_FACTOR_REQUIRED")
        throw error;
      if (info) return await handleSignInError(tx, userId, state, info, error);
      await disposePending(tx, userId);
      throw await errorForAuth(tx, userId, error);
    } finally {
      if (info) await destroyClient(info.client);
    }
  });
}

export async function signInWithPassword(
  userId: number,
  password: string,
  commit?: CommitAuth
): Promise<SignInResult> {
  return serializedAuth(userId, async tx => {
    const state = await requirePending(tx, userId);
    if (!state.needsPassword)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Сначала подтвердите код Telegram.",
      });
    let info: MtprotoClientInfo | undefined;
    try {
      if (!password || password.length > 256)
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Введите пароль двухэтапной проверки.",
        });
      info = await createClient(state.sessionString);
      const active = info;
      await bounded(active.client, async ensureActive => {
        await active.client.connect();
        ensureActive();
        const passwordInfo = await active.client.invoke(
          new Api.account.GetPassword()
        );
        const { computeCheck } = await import("telegram/Password.js");
        const proof = await computeCheck(passwordInfo, password);
        ensureActive();
        await active.client.invoke(
          new Api.auth.CheckPassword({
            password: proof,
          })
        );
      });
      return await completeAuth(tx, userId, state, active, commit);
    } catch (error) {
      if (info) return await handleSignInError(tx, userId, state, info, error);
      await disposePending(tx, userId);
      throw await errorForAuth(tx, userId, error);
    } finally {
      if (info) await destroyClient(info.client);
    }
  });
}

export async function logoutSession(userId: number): Promise<void> {
  return serializedAuth(userId, async (tx, discardConnection) => {
    await disposePending(tx, userId);
    const key = `${userId}:mtproto`;
    let locked = false;
    let broken = false;
    const connectionError = () => {
      broken = true;
    };
    tx.on("error", connectionError);
    try {
      // The persistent state stops new work; the advisory lock waits for an active dispatch.
      await tx.query(
        `INSERT INTO sender_controls(sender_key,owner_id,kind,state,reason) VALUES($1,$2,'mtproto','AUTH_REQUIRED','OWNER_DISCONNECTED')
        ON CONFLICT(sender_key) DO UPDATE SET state='AUTH_REQUIRED',reason='OWNER_DISCONNECTED',updated_at=now()`,
        [key, userId]
      );
      await tx.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [
        `tg-sender:${key}`,
      ]);
      locked = true;
      const stored = await getMtprotoSession(userId).catch(() => null);
      await tx.query(
        `UPDATE sender_controls SET state='AUTH_REQUIRED',reason='OWNER_DISCONNECTED',updated_at=now() WHERE sender_key=$1`,
        [key]
      );
      await tx.query('DELETE FROM mtproto_sessions WHERE "userId"=$1', [
        userId,
      ]);
      if (stored?.sessionString) {
        let client: TelegramClient | undefined;
        try {
          ({ client } = await createClient(stored.sessionString));
          const connected = client;
          await bounded(connected, async ensureActive => {
            await connected.connect();
            ensureActive();
            await connected.invoke(new Api.auth.LogOut());
          });
        } catch {
          /* Local credentials are revoked even when Telegram is unavailable. */
        } finally {
          if (client) await destroyClient(client);
        }
      }
    } finally {
      if (locked && !broken)
        await tx
          .query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
            `tg-sender:${key}`,
          ])
          .catch(() => {
            broken = true;
            discardConnection();
          });
      tx.removeListener("error", connectionError);
    }
  });
}
