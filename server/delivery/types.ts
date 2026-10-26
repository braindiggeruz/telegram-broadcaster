import type { Pool } from "pg";

export type SenderKind = "bot" | "mtproto";
export type ParseMode = "HTML" | "Markdown" | "MarkdownV2" | "None" | null;
export type DeliveryErrorCategory =
  | "recipient"
  | "cooldown"
  | "slowmode"
  | "restricted"
  | "auth"
  | "content"
  | "transient";

/** Only use for a confirmed Telegram rejection, or a failure known to precede dispatch.
 * Network timeouts and ambiguous responses must remain unknown. Never put raw API URLs in code.
 */
export class DeliveryError extends Error {
  constructor(
    public readonly category: DeliveryErrorCategory,
    public readonly code: string,
    public readonly retryAfterSeconds?: number
  ) {
    super(code);
    this.name = "DeliveryError";
  }
}

export interface DeliveryRequest {
  ownerId: number;
  kind: SenderKind;
  /** Canonical chat:<signed id>, phone:+<digits>, or username:<name>. */
  recipient: string;
  message: string;
  /** Owner-scoped immutable photo pinned when the campaign was approved. */
  photoId?: string | null;
  photoSha256?: string | null;
  parseMode: ParseMode;
  deliveryId: string;
  /** Persisted positive 63-bit value; MTProto must reuse it for this logical message. */
  randomId: string;
  signal: AbortSignal;
  /** SHA-256 of the transport credential approved with this campaign. */
  senderFingerprint?: string;
}
export interface DeliveryTransport {
  /** Must honor signal. The engine keeps its sender lock until this promise settles. */
  send(request: DeliveryRequest): Promise<{ messageId?: string }>;
}
export interface EnqueueInput {
  ownerId: number;
  kind: SenderKind;
  broadcastId: number;
  message: string;
  photoId?: string | null;
  photoSha256?: string | null;
  parseMode?: ParseMode;
  recipients: string[];
  delaySeconds: number;
  isDryRun: boolean;
  scheduledAt?: Date;
  expiresAt?: Date;
  senderFingerprint?: string;
}
export interface WorkerOptions {
  pool?: Pool;
  transport: DeliveryTransport;
  liveSendEnabled?: boolean;
  contactMinIntervalSeconds?: number;
  dispatchTimeoutMs?: number;
  workerId?: string;
}

export function senderKey(ownerId: number, kind: SenderKind): string {
  if (
    !Number.isSafeInteger(ownerId) ||
    ownerId <= 0 ||
    !["bot", "mtproto"].includes(kind)
  )
    throw new Error("INVALID_SENDER");
  return `${ownerId}:${kind}`;
}

/** Typed IDs prevent a long numeric chat ID being reinterpreted as a phone number. */
export function normalizeRecipient(value: string): string {
  const input = String(value).trim();
  if (/^(?:chat:)?-?[1-9]\d{0,19}$/.test(input))
    return `chat:${BigInt(input.replace(/^chat:/, "")).toString()}`;
  if (/^(?:phone:)?\+[1-9]\d{6,14}$/.test(input))
    return `phone:${input.replace(/^phone:/, "")}`;
  const username = input.replace(/^(?:username:|@)/, "").toLowerCase();
  if (/^(?:username:|@)/.test(input) && /^[a-z][a-z0-9_]{3,31}$/.test(username))
    return `username:${username}`;
  throw new Error(
    "INVALID_RECIPIENT: use chat:<id>, phone:+<number>, or username:<name>"
  );
}

export function safeCode(value: string): string {
  // Structured codes only. Never retain raw exception messages containing token URLs or personal data.
  return /^[A-Z0-9_:-]{1,100}$/.test(value) ? value : "TRANSPORT_ERROR";
}
