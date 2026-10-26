export type LoginCodeDelivery =
  | "telegram"
  | "sms"
  | "call"
  | "email"
  | "unknown";

export interface MtprotoAuthStatus {
  serverNow: string;
  retryAt: string | null;
  attemptsRemaining: number;
  pending: {
    step: "code" | "password";
    maskedPhone: string;
    expiresAt: string;
    codeAttemptsRemaining: number;
    delivery: LoginCodeDelivery;
    codeLength: number | null;
  } | null;
}
