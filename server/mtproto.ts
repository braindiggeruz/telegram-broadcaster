/**
 * MTProto service — wraps GramJS TelegramClient for user-account auth & messaging.
 * One client instance is cached per userId in memory for the lifetime of the process.
 */
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Api } from "telegram";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MtprotoClientInfo {
  client: TelegramClient;
  session: StringSession;
}

// In-memory client cache: userId → client
const clientCache = new Map<number, MtprotoClientInfo>();

// Pending auth state (phone code hash, etc.) per userId
interface PendingAuth {
  phoneCodeHash: string;
  phone: string;
  client: TelegramClient;
  session: StringSession;
}
const pendingAuth = new Map<number, PendingAuth>();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getApiCredentials() {
  // Telegram API credentials — users must supply their own via env or we use
  // well-known test credentials for development.
  const apiId = parseInt(process.env.TELEGRAM_API_ID ?? "2040");
  const apiHash = process.env.TELEGRAM_API_HASH ?? "b18441a1ff607e10a989891a5462e627";
  return { apiId, apiHash };
}

export async function createClient(sessionString = ""): Promise<MtprotoClientInfo> {
  const { apiId, apiHash } = getApiCredentials();
  const session = new StringSession(sessionString);
  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 3,
    useWSS: false,
  });
  return { client, session };
}

// ─── Auth: Phone + SMS code ───────────────────────────────────────────────────

export async function sendPhoneCode(userId: number, phone: string): Promise<{ phoneCodeHash: string }> {
  const { client, session } = await createClient();
  await client.connect();

  const result = await client.invoke(
    new Api.auth.SendCode({
      phoneNumber: phone,
      apiId: parseInt(process.env.TELEGRAM_API_ID ?? "2040"),
      apiHash: process.env.TELEGRAM_API_HASH ?? "b18441a1ff607e10a989891a5462e627",
      settings: new Api.CodeSettings({}),
    })
  );

  const phoneCodeHash = (result as Api.auth.SentCode).phoneCodeHash;

  pendingAuth.set(userId, { phoneCodeHash, phone, client, session });

  return { phoneCodeHash };
}

export async function signInWithCode(
  userId: number,
  code: string
): Promise<{ sessionString: string; user: { id: string; firstName: string; lastName: string; username: string; phone: string } }> {
  const pending = pendingAuth.get(userId);
  if (!pending) throw new Error("No pending auth for this user. Please request a code first.");

  const { client, session, phone, phoneCodeHash } = pending;

  try {
    await client.invoke(
      new Api.auth.SignIn({
        phoneNumber: phone,
        phoneCodeHash,
        phoneCode: code,
      })
    );
  } catch (err: unknown) {
    const e = err as { errorMessage?: string };
    if (e?.errorMessage === "SESSION_PASSWORD_NEEDED") {
      throw new Error("TWO_FACTOR_REQUIRED");
    }
    throw err;
  }

  const me = (await client.getMe()) as Api.User;
  const sessionString = session.save() as unknown as string;

  clientCache.set(userId, { client, session });
  pendingAuth.delete(userId);

  return {
    sessionString,
    user: {
      id: me.id.toString(),
      firstName: me.firstName ?? "",
      lastName: me.lastName ?? "",
      username: me.username ?? "",
      phone: me.phone ?? phone,
    },
  };
}

export async function signInWithPassword(
  userId: number,
  password: string
): Promise<{ sessionString: string; user: { id: string; firstName: string; lastName: string; username: string; phone: string } }> {
  const pending = pendingAuth.get(userId);
  if (!pending) throw new Error("No pending auth for this user.");

  const { client, session, phone } = pending;

  const pwdInfo = await client.invoke(new Api.account.GetPassword());
  await client.invoke(
    new Api.auth.CheckPassword({
      password: await computePasswordCheck(pwdInfo, password),
    })
  );

  const me = (await client.getMe()) as Api.User;
  const sessionString = session.save() as unknown as string;

  clientCache.set(userId, { client, session });
  pendingAuth.delete(userId);

  return {
    sessionString,
    user: {
      id: me.id.toString(),
      firstName: me.firstName ?? "",
      lastName: me.lastName ?? "",
      username: me.username ?? "",
      phone: me.phone ?? phone,
    },
  };
}

async function computePasswordCheck(pwdInfo: Api.account.Password, password: string) {
  // Use GramJS built-in password computation
  const { computeCheck } = await import("telegram/Password.js");
  return computeCheck(pwdInfo, password);
}

// ─── Session restore ──────────────────────────────────────────────────────────

export async function restoreSession(userId: number, sessionString: string): Promise<boolean> {
  try {
    const { client, session } = await createClient(sessionString);
    await client.connect();
    const me = await client.getMe();
    if (!me) return false;
    clientCache.set(userId, { client, session });
    return true;
  } catch {
    return false;
  }
}

export async function getActiveClient(userId: number, sessionString: string): Promise<TelegramClient | null> {
  if (clientCache.has(userId)) {
    const cached = clientCache.get(userId)!;
    try {
      if (await cached.client.isUserAuthorized()) return cached.client;
    } catch {
      clientCache.delete(userId);
    }
  }

  const ok = await restoreSession(userId, sessionString);
  if (ok) return clientCache.get(userId)!.client;
  return null;
}

export async function logoutSession(userId: number): Promise<void> {
  const cached = clientCache.get(userId);
  if (cached) {
    try {
      await cached.client.invoke(new Api.auth.LogOut());
    } catch { /* ignore */ }
    await cached.client.disconnect();
    clientCache.delete(userId);
  }
  pendingAuth.delete(userId);
}

// ─── Sending ──────────────────────────────────────────────────────────────────

export interface SendResult {
  recipient: string;
  success: boolean;
  error?: string;
}

export async function sendMessageToUser(
  client: TelegramClient,
  recipient: string,
  message: string,
  parseMode: "HTML" | "Markdown" | "MarkdownV2" | "None"
): Promise<SendResult> {
  try {
    const formattingMode = parseMode === "None" ? undefined : parseMode.toLowerCase() as "html" | "markdown";
    await client.sendMessage(recipient, {
      message,
      parseMode: formattingMode,
    });
    return { recipient, success: true };
  } catch (err: unknown) {
    const e = err as { message?: string };
    return { recipient, success: false, error: e?.message ?? String(err) };
  }
}
