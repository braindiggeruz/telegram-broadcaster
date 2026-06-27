/**
 * MTProto service — wraps GramJS TelegramClient for user-account auth & messaging.
 * One client instance is cached per userId in memory for the lifetime of the process.
 */
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Api } from "telegram";
import bigInt from "big-integer";

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
    connectionRetries: 5,
    useWSS: false,
    floodSleepThreshold: 120,
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
  // Account-level limit (PEER_FLOOD, long FLOOD_WAIT, banned/frozen session).
  // When true the caller MUST stop the whole broadcast to avoid extending the ban.
  fatal?: boolean;
}

// Errors that mean the SENDER account itself is restricted — not just one recipient.
function isAccountLevelError(msg: string): boolean {
  return /PEER_FLOOD|FLOOD_WAIT|USER_DEACTIVATED|USER_RESTRICTED|FROZEN|AUTH_KEY|SESSION_REVOKED|USER_BANNED|PHONE_NUMBER_BANNED|INPUT_USER_DEACTIVATED_ALL/i.test(msg);
}

// Track contacts imported during a broadcast so we can clean them up afterwards.
const importedContacts = new Map<TelegramClient, Api.User[]>();

function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length < 10 || digits.length > 15) return null;
  return digits;
}

function looksLikePhone(raw: string): boolean {
  const t = raw.trim();
  if (t.startsWith("@")) return false;
  return /^\+?[\d\s\-()]{10,20}$/.test(t) && normalizePhone(t) !== null;
}

// Resolve a phone number to a Telegram user via contacts.ImportContacts.
// Returns null when the number has no Telegram account or hides itself via
// privacy settings ("who can find me by phone number").
async function resolvePhoneEntity(client: TelegramClient, phone: string): Promise<Api.User | null> {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;

  const res = (await client.invoke(
    new Api.contacts.ImportContacts({
      contacts: [
        new Api.InputPhoneContact({
          clientId: bigInt(Date.now() + Math.floor(Math.random() * 1e6)),
          phone: normalized,
          firstName: "Student",
          lastName: "",
        }),
      ],
    })
  )) as Api.contacts.ImportedContacts;

  const user = res.users?.find((u): u is Api.User => u instanceof Api.User) ?? null;
  if (user) {
    const list = importedContacts.get(client) ?? [];
    list.push(user);
    importedContacts.set(client, list);
  }
  return user;
}

export async function sendMessageToUser(
  client: TelegramClient,
  recipient: string,
  message: string,
  parseMode: "HTML" | "Markdown" | "MarkdownV2" | "None"
): Promise<SendResult> {
  const formattingMode =
    parseMode === "None" ? undefined : parseMode === "HTML" ? "html" : "markdown";

  const send = async (): Promise<SendResult> => {
    let target: string | Api.User = recipient.trim();

    if (looksLikePhone(recipient)) {
      const entity = await resolvePhoneEntity(client, recipient);
      if (!entity) {
        return {
          recipient,
          success: false,
          error: "Номер не найден в Telegram или скрыт настройками приватности",
        };
      }
      target = entity;
    }

    await client.sendMessage(target, { message, parseMode: formattingMode as "html" | "markdown" | undefined });
    return { recipient, success: true };
  };

  try {
    return await send();
  } catch (err: unknown) {
    const e = err as { seconds?: number; errorMessage?: string; message?: string };
    const msg = e?.errorMessage ?? e?.message ?? String(err);
    // FLOOD_WAIT_X: short waits → sleep & retry once. Long waits → fatal (stop broadcast).
    if (typeof e?.seconds === "number" && e.seconds > 0) {
      if (e.seconds <= 120) {
        await new Promise((r) => setTimeout(r, (e.seconds! + 1) * 1000));
        try {
          return await send();
        } catch (err2: unknown) {
          const e2 = err2 as { errorMessage?: string; message?: string };
          const m2 = e2?.errorMessage ?? e2?.message ?? String(err2);
          return { recipient, success: false, error: m2, fatal: isAccountLevelError(m2) };
        }
      }
      return { recipient, success: false, error: `FLOOD_WAIT ${e.seconds}s — слишком долгая пауза, рассылка остановлена`, fatal: true };
    }
    return { recipient, success: false, error: msg, fatal: isAccountLevelError(msg) };
  }
}

// Remove the contacts that were imported during a broadcast so the sender's
// address book is not polluted with thousands of students.
export async function cleanupImportedContacts(client: TelegramClient): Promise<void> {
  const list = importedContacts.get(client);
  if (!list || list.length === 0) return;
  try {
    const ids = list.map(
      (u) => new Api.InputUser({ userId: u.id, accessHash: u.accessHash ?? bigInt(0) })
    );
    await client.invoke(new Api.contacts.DeleteContacts({ id: ids }));
  } catch {
    /* best-effort cleanup */
  }
  importedContacts.delete(client);
}
