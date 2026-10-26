const MAX_ENTRIES = 2000;
const MAX_EXPANDED_BYTES = 25 * 1024 * 1024;
const MAX_RATIO = 100;

/** Reject oversized/ambiguous ZIP directories before ExcelJS allocates inflated XML. */
export function inspectXlsxZip(input: ArrayBuffer | Uint8Array) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const invalid = () => {
    throw new Error("Некорректный XLSX. Пересохраните файл как XLSX или CSV.");
  };
  if (bytes.length < 22) return invalid();
  let end = -1;
  for (
    let offset = bytes.length - 22;
    offset >= Math.max(0, bytes.length - 65557);
    offset--
  ) {
    if (
      view.getUint32(offset, true) === 0x06054b50 &&
      offset + 22 + view.getUint16(offset + 20, true) === bytes.length
    ) {
      end = offset;
      break;
    }
  }
  if (end < 0) return invalid();
  const entries = view.getUint16(end + 10, true);
  const size = view.getUint32(end + 12, true);
  const start = view.getUint32(end + 16, true);
  if (
    view.getUint16(end + 4, true) ||
    view.getUint16(end + 6, true) ||
    view.getUint16(end + 8, true) !== entries ||
    start === 0xffffffff ||
    size === 0xffffffff
  )
    return invalid();
  if (!entries || entries > MAX_ENTRIES)
    throw new Error(
      "В XLSX слишком много внутренних файлов. Сохраните нужный лист отдельно."
    );
  if (start + size !== end || start > end) return invalid();
  let offset = start,
    expanded = 0,
    compressed = 0;
  const names = new Set<string>();
  const decoder = new TextDecoder();
  for (let index = 0; index < entries; index++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50)
      return invalid();
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const packed = view.getUint32(offset + 20, true);
    const unpacked = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const local = view.getUint32(offset + 42, true);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (
      next > end ||
      !nameLength ||
      flags & 1 ||
      ![0, 8].includes(method) ||
      local + 30 > start ||
      view.getUint32(local, true) !== 0x04034b50
    )
      return invalid();
    const payload =
      local +
      30 +
      view.getUint16(local + 26, true) +
      view.getUint16(local + 28, true);
    if (payload + packed > start) return invalid();
    const name = decoder.decode(
      bytes.subarray(offset + 46, offset + 46 + nameLength)
    );
    if (names.has(name)) return invalid();
    names.add(name);
    expanded += unpacked;
    compressed += packed;
    if (expanded > MAX_EXPANDED_BYTES || unpacked > MAX_EXPANDED_BYTES)
      throw new Error(
        "Распакованный XLSX больше 25 МБ. Разделите файл или используйте CSV."
      );
    if (unpacked > Math.max(packed, 1) * MAX_RATIO)
      throw new Error(
        "Слишком высокая степень сжатия XLSX. Пересохраните нужный лист как CSV."
      );
    offset = next;
  }
  if (offset !== end || expanded > Math.max(compressed, 1) * MAX_RATIO)
    return invalid();
  return { entryCount: entries, uncompressedBytes: expanded };
}
