const SENSITIVE_KEY =
  /(?:password|passphrase|token|secret|sessionstring|authorization|cookie|phonecodehash|code|apikey|api_hash)/i;

export function redactSensitive(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[omitted]";
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value))
    return value.map(item => redactSensitive(item, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SENSITIVE_KEY.test(key)
          ? "[redacted]"
          : redactSensitive(item, depth + 1),
      ])
    );
  return value;
}

export function redactText(value: string): string {
  return value
    .replace(/bot\d{5,}:[A-Za-z0-9_-]{15,}/g, "bot[redacted]")
    .replace(/\b\d{5,}:[A-Za-z0-9_-]{15,}\b/g, "[redacted-token]")
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[redacted-database-url]")
    .replace(/enc:v1:[A-Za-z0-9_:-]+/g, "[redacted-secret]");
}
