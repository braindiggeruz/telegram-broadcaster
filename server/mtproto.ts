/** Short-lived MTProto authentication. Delivery clients are owned by the worker. */
import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Logger, LogLevel } from "telegram/extensions/Logger.js";
import { TRPCError } from "@trpc/server";
import type { PoolClient } from "pg";
import { getPool } from "./connection";
import { getMtprotoSession } from "./db";
import { decryptSecret, encryptSecret } from "./security/secrets";

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
  const problem = error as { errorMessage?: string; seconds?: number };
  const code = problem?.errorMessage ?? "";
  const wait = Number(problem?.seconds);
  if (/^FLOOD_WAIT(?:_\d+)?$/.test(code) && Number.isFinite(wait) && wait > 0) {
    await tx.query(
      `UPDATE mtproto_auth_controls SET next_code_at=GREATEST(next_code_at,now()+$2*interval '1 second') WHERE user_id=$1`,
      [userId, Math.ceil(wait)]
    );
    return new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: `Telegram требует паузу ${Math.ceil(wait)} сек. Автоматический повтор отключён.`,
    });
  }
  const messages: Record<string, string> = {
    PHONE_CODE_INVALID: "Неверный код Telegram.",
    PHONE_CODE_EMPTY: "Введите код Telegram.",
    PHONE_CODE_EXPIRED: "Код Telegram истёк. Запросите новый код.",
    PASSWORD_HASH_INVALID: "Неверный пароль двухэтапной проверки.",
    PHONE_NUMBER_INVALID: "Некорректный номер телефона.",
    PHONE_NUMBER_BANNED:
      "Telegram ограничил этот номер. Проверьте статус аккаунта.",
    PHONE_NUMBER_FLOOD: "Telegram ограничил запросы кода. Повторите позже.",
    AUTH_RESTART: "Telegram завершил попытку входа. Запросите новый код.",
  };
  return new TRPCError({
    code: "BAD_REQUEST",
    message:
      messages[code] ??
      "Не удалось выполнить вход в Telegram. Проверьте подключение и начните вход заново.",
  });
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

export async function sendPhoneCode(
  userId: number,
  phone: string
): Promise<{ phoneCodeHash: string }> {
  return serializedAuth(userId, async tx => {
    if (!/^\+[1-9]\d{6,14}$/.test(phone))
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Номер должен быть в международном формате +998…",
      });
    const credentials = getApiCredentials();
    await claimCodeRequest(tx, userId);
    await disposePending(tx, userId);
    const { client, session } = await createClient();
    try {
      const result = await bounded(client, async ensureActive => {
        await client.connect();
        ensureActive();
        return client.invoke(
          new Api.auth.SendCode({
            phoneNumber: phone,
            ...credentials,
            settings: new Api.CodeSettings({}),
          })
        );
      });
      const phoneCodeHash = (result as Api.auth.SentCode).phoneCodeHash;
      if (!phoneCodeHash) throw new Error("UNEXPECTED_AUTH_RESULT");
      const state: PendingAuth = {
        phoneCodeHash,
        phone,
        sessionString: session.save() as unknown as string,
        expiresAt: Date.now() + AUTH_TTL_MS,
        attempts: 0,
        needsPassword: false,
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
      await disposePending(tx, userId);
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
  if (
    !state ||
    typeof state.sessionString !== "string" ||
    !state.sessionString ||
    typeof state.phoneCodeHash !== "string" ||
    !state.phoneCodeHash ||
    typeof state.phone !== "string" ||
    !/^\+[1-9]\d{6,14}$/.test(state.phone) ||
    !Number.isFinite(state.expiresAt) ||
    state.expiresAt <= Date.now() ||
    !Number.isInteger(state.attempts) ||
    state.attempts < 0 ||
    state.attempts >= 5 ||
    typeof state.needsPassword !== "boolean"
  ) {
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
