import type { BotSettings, MtprotoSession } from "../../drizzle/schema";

export function botSettingsDto(value: BotSettings | null) {
  if (!value) return null;
  const {
    id,
    botName,
    botUsername,
    isValid,
    validatedAt,
    createdAt,
    updatedAt,
  } = value;
  return {
    id,
    botName,
    botUsername,
    isValid,
    validatedAt,
    createdAt,
    updatedAt,
    configured: true,
  };
}

export function mtprotoSessionDto(value: MtprotoSession | null) {
  if (!value) return null;
  const {
    id,
    phone,
    firstName,
    lastName,
    username,
    telegramId,
    isActive,
    createdAt,
    updatedAt,
  } = value;
  return {
    id,
    phone,
    firstName,
    lastName,
    username,
    telegramId,
    isActive,
    createdAt,
    updatedAt,
  };
}
