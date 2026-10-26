export type RecipientType = "chat_id" | "username" | "phone" | "auto";
export type NormalizedRecipient = {
  value: string;
  type: Exclude<RecipientType, "auto">;
};

/** Never extract digits from arbitrary prose or infer a phone from a numeric ID. */
export function normalizeRecipient(
  raw: unknown,
  type: RecipientType = "auto"
): NormalizedRecipient | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  if (typeof raw === "number" && !Number.isSafeInteger(raw)) return null;
  const value = String(raw).trim();
  if (!value) return null;
  const actual =
    type === "auto"
      ? value.startsWith("@")
        ? "username"
        : value.startsWith("+")
          ? "phone"
          : "chat_id"
      : type;
  if (actual === "username") {
    const username = value.replace(/^@/, "");
    return /^[a-zA-Z][a-zA-Z0-9_]{3,31}$/.test(username)
      ? { value: `@${username.toLowerCase()}`, type: "username" }
      : null;
  }
  if (actual === "phone") {
    if (!/^\+?[\d ()-]+$/.test(value) || value.startsWith("-")) return null;
    const digits = value.replace(/[+ ()-]/g, "");
    return /^[1-9]\d{9,14}$/.test(digits)
      ? { value: `+${digits}`, type: "phone" }
      : null;
  }
  if (!/^-?[1-9]\d*$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? { value, type: "chat_id" } : null;
}

export function previewRecipients(
  rows: unknown[][],
  column: number,
  type: RecipientType,
  skipHeader: boolean
) {
  const seen = new Set<string>();
  const valid: NormalizedRecipient[] = [];
  const invalid: { row: number; value: string }[] = [];
  let duplicates = 0;
  rows.forEach((row, index) => {
    if (skipHeader && index === 0) return;
    const raw = row[column];
    if (String(raw ?? "").trim() === "") return;
    const recipient = normalizeRecipient(raw, type);
    if (!recipient) {
      invalid.push({ row: index + 1, value: String(raw).slice(0, 150) });
      return;
    }
    const key = `${recipient.type}:${recipient.value}`;
    if (seen.has(key)) {
      duplicates++;
      return;
    }
    seen.add(key);
    valid.push(recipient);
  });
  return { valid, invalid, duplicates };
}

/** RFC-style quoted CSV, including escaped quotes and embedded newlines. */
export function parseRecipientCsv(content: string): string[][] {
  const clean = content.replace(/^\uFEFF/, "");
  const first = clean.split(/\r?\n/, 1)[0] ?? "";
  const delimiter =
    first.includes(";") && !first.includes(",")
      ? ";"
      : first.includes("\t") && !first.includes(",")
        ? "\t"
        : ",";
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (ch === '"') {
      if (quoted && clean[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (!quoted && cell.length)
        throw new Error("Кавычка внутри неэкранированного поля CSV");
      else quoted = !quoted;
    } else if (!quoted && ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (!quoted && (ch === "\n" || ch === "\r")) {
      if (ch === "\r" && clean[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      if (rows.length > 20000)
        throw new Error("Максимум 20 000 строк за один импорт");
    } else cell += ch;
  }
  if (quoted) throw new Error("Незакрытая кавычка в CSV");
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}
