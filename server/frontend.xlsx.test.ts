import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { inspectXlsxZip } from "../shared/xlsxSafety";

function fixture({ expanded = 1, packed = 1, count = 1 } = {}) {
  const central = 31 + packed;
  const end = central + 47;
  const bytes = new Uint8Array(end + 22);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(26, 1, true);
  bytes[30] = 65;
  view.setUint32(central, 0x02014b50, true);
  view.setUint16(central + 10, 8, true);
  view.setUint32(central + 20, packed, true);
  view.setUint32(central + 24, expanded, true);
  view.setUint16(central + 28, 1, true);
  bytes[central + 46] = 65;
  view.setUint32(end, 0x06054b50, true);
  view.setUint16(end + 8, count, true);
  view.setUint16(end + 10, count, true);
  view.setUint32(end + 12, 47, true);
  view.setUint32(end + 16, central, true);
  return bytes;
}

describe("XLSX preflight before XML inflation", () => {
  it("accepts a genuine workbook and bounds its XML size", async () => {
    const workbook = new ExcelJS.Workbook();
    workbook
      .addWorksheet("Recipients")
      .addRows([["chat_id"], ["-1001234567890"], ["123456789"]]);
    const buffer = await workbook.xlsx.writeBuffer();
    const result = inspectXlsxZip(new Uint8Array(buffer));
    expect(result.entryCount).toBeGreaterThan(1);
    expect(result.uncompressedBytes).toBeGreaterThan(100);
    expect(result.uncompressedBytes).toBeLessThan(25 * 1024 * 1024);
  });
  it("rejects declared expansion bombs, extreme compression and too many entries", () => {
    expect(() =>
      inspectXlsxZip(fixture({ expanded: 26 * 1024 * 1024 }))
    ).toThrow("25 МБ");
    expect(() => inspectXlsxZip(fixture({ expanded: 101, packed: 1 }))).toThrow(
      "сжатия"
    );
    expect(() => inspectXlsxZip(fixture({ count: 2001 }))).toThrow("много");
  });
  it("rejects truncated and inconsistent central directory offsets", () => {
    expect(() => inspectXlsxZip(new Uint8Array(4))).toThrow();
    const malformed = fixture();
    const view = new DataView(malformed.buffer);
    view.setUint32(malformed.length - 6, 0xffffffff, true);
    expect(() => inspectXlsxZip(malformed)).toThrow();
  });
});
