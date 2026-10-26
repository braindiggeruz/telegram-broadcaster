export const LOGIN_PHONE_ERROR =
  "Введите номер в международном формате с + и кодом страны, например +998 90 000 00 00.";

/** Normalize familiar phone formatting without guessing a country or extracting digits from text. */
export function normalizeLoginPhone(value: string): string | null {
  if (value.length > 64 || !/^[+\d\s().-]+$/.test(value)) return null;
  const normalized = value.replace(/[\s().-]/g, "");
  return /^\+[1-9]\d{6,14}$/.test(normalized) ? normalized : null;
}
