/** Short-lived MTProto authentication. Delivery clients are owned by the worker. */
import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Logger, LogLevel } from "telegram/extensions/Logger.js";
import { TRPCError } from "@trpc/server";
import { getPool } from "./connection";
import { getMtprotoSession } from "./db";

export interface MtprotoClientInfo {
  client: TelegramClient;
  session: StringSession;
}
interface PendingAuth extends MtprotoClientInfo {
  phoneCodeHash: string;
  phone: string;
  expiresAt: number;
  attempts: number;
  needsPassword: boolean;
  timer: ReturnType<typeof setTimeout>;
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
const pendingAuth = new Map<number, PendingAuth>();
const activeAuthRequests = new Set<number>();
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

async function disposePending(userId: number, expected?: PendingAuth) {
  const state = pendingAuth.get(userId);
  if (!state || (expected && state !== expected)) return;
  pendingAuth.delete(userId);
  clearTimeout(state.timer);
  await destroyClient(state.client);
}

async function serializedAuth<T>(
  userId: number,
  operation: () => Promise<T>
): Promise<T> {
  if (!Number.isSafeInteger(userId) || userId <= 0)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Некорректный владелец",
    });
  if (activeAuthRequests.has(userId))
    throw new TRPCError({
      code: "CONFLICT",
      message: "Дождитесь завершения текущего запроса входа.",
    });
  activeAuthRequests.add(userId);
  try {
    return await operation();
  } finally {
    activeAuthRequests.delete(userId);
  }
}

async function bounded<T>(
  client: TelegramClient,
  work: () => Promise<T>
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          void destroyClient(client);
          reject(
            new TRPCError({
              code: "TIMEOUT",
              message:
                "Telegram не ответил вовремя. Запрос не повторялся автоматически.",
            })
          );
        }, AUTH_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function errorForAuth(
  userId: number,
  error: unknown
): Promise<TRPCError> {
  if (error instanceof TRPCError) return error;
  const problem = error as { errorMessage?: string; seconds?: number };
  const code = problem?.errorMessage ?? "";
  const wait = Number(problem?.seconds);
  if (/^FLOOD_WAIT(?:_\d+)?$/.test(code) && Number.isFinite(wait) && wait > 0) {
    await getPool().query(
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

async function claimCodeRequest(userId: number) {
  const result = await getPool().query(
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
  return serializedAuth(userId, async () => {
    if (!/^\+[1-9]\d{6,14}$/.test(phone))
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Номер должен быть в международном формате +998…",
      });
    const credentials = getApiCredentials();
    await claimCodeRequest(userId);
    await disposePending(userId);
    const { client, session } = await createClient();
    try {
      const result = await bounded(client, async () => {
        await client.connect();
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
      const state = {
        phoneCodeHash,
        phone,
        client,
        session,
        expiresAt: Date.now() + AUTH_TTL_MS,
        attempts: 0,
        needsPassword: false,
      } as PendingAuth;
      state.timer = setTimeout(() => {
        void disposePending(userId, state);
      }, AUTH_TTL_MS);
      state.timer.unref?.();
      pendingAuth.set(userId, state);
      return { phoneCodeHash };
    } catch (error) {
      await destroyClient(client);
      throw await errorForAuth(userId, error);
    }
  });
}

async function requirePending(userId: number): Promise<PendingAuth> {
  const state = pendingAuth.get(userId);
  if (!state || state.expiresAt <= Date.now() || state.attempts >= 5) {
    await disposePending(userId);
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Попытка входа истекла или исчерпана. Запросите новый код.",
    });
  }
  state.attempts++;
  return state;
}

async function completeAuth(
  userId: number,
  state: PendingAuth
): Promise<SignInResult> {
  const me = (await bounded(state.client, () =>
    state.client.getMe()
  )) as Api.User;
  if (pendingAuth.get(userId) !== state || state.expiresAt <= Date.now())
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Попытка входа истекла. Запросите новый код.",
    });
  const sessionString = state.session.save() as unknown as string;
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
  await disposePending(userId, state);
  return result;
}

async function handleSignInError(
  userId: number,
  state: PendingAuth,
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
  )
    await disposePending(userId, state);
  throw await errorForAuth(userId, error);
}

export async function signInWithCode(
  userId: number,
  code: string
): Promise<SignInResult> {
  return serializedAuth(userId, async () => {
    const state = await requirePending(userId);
    try {
      if (!/^\d{4,8}$/.test(code))
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Введите код из сообщения Telegram.",
        });
      try {
        await bounded(state.client, () =>
          state.client.invoke(
            new Api.auth.SignIn({
              phoneNumber: state.phone,
              phoneCodeHash: state.phoneCodeHash,
              phoneCode: code,
            })
          )
        );
      } catch (error) {
        if (
          (error as { errorMessage?: string })?.errorMessage ===
          "SESSION_PASSWORD_NEEDED"
        ) {
          state.needsPassword = true;
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "TWO_FACTOR_REQUIRED",
          });
        }
        throw error;
      }
      return await completeAuth(userId, state);
    } catch (error) {
      if (error instanceof TRPCError && error.message === "TWO_FACTOR_REQUIRED")
        throw error;
      return handleSignInError(userId, state, error);
    }
  });
}

export async function signInWithPassword(
  userId: number,
  password: string
): Promise<SignInResult> {
  return serializedAuth(userId, async () => {
    const state = await requirePending(userId);
    if (!state.needsPassword)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Сначала подтвердите код Telegram.",
      });
    try {
      if (!password || password.length > 256)
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Введите пароль двухэтапной проверки.",
        });
      await bounded(state.client, async () => {
        const info = await state.client.invoke(new Api.account.GetPassword());
        const { computeCheck } = await import("telegram/Password.js");
        await state.client.invoke(
          new Api.auth.CheckPassword({
            password: await computeCheck(info, password),
          })
        );
      });
      return await completeAuth(userId, state);
    } catch (error) {
      return handleSignInError(userId, state, error);
    }
  });
}

export async function logoutSession(userId: number): Promise<void> {
  return serializedAuth(userId, async () => {
    await disposePending(userId);
    const tx = await getPool().connect();
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
          await bounded(connected, async () => {
            await connected.connect();
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
          });
      tx.removeListener("error", connectionError);
      tx.release(broken);
    }
  });
}
