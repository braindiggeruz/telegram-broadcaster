import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import MessagePreview, {
  safePreviewUrl,
} from "../client/src/components/MessagePreview";
import {
  normalizeRecipient,
  parseRecipientCsv,
  previewRecipients,
} from "../shared/recipients";

describe("typed audience import regressions", () => {
  it("preserves signed chat IDs and never guesses phones from numeric IDs", () => {
    expect(normalizeRecipient("-1001234567890")).toEqual({
      value: "-1001234567890",
      type: "chat_id",
    });
    expect(normalizeRecipient("123456789")).toEqual({
      value: "123456789",
      type: "chat_id",
    });
    expect(normalizeRecipient("998901234567")).toEqual({
      value: "998901234567",
      type: "chat_id",
    });
    expect(normalizeRecipient("998901234567", "phone")).toEqual({
      value: "+998901234567",
      type: "phone",
    });
  });
  it("rejects numbers embedded in prose, scientific notation and rounded numeric cells", () => {
    for (const value of [
      "order 123456789012",
      "1.234e12",
      Number.MAX_SAFE_INTEGER + 1,
      "12.5",
      "=SUM(A1)",
      { text: "+998901234567" },
    ])
      expect(normalizeRecipient(value)).toBeNull();
    expect(normalizeRecipient("order 123456789012", "phone")).toBeNull();
    expect(normalizeRecipient("-1001234567890", "phone")).toBeNull();
  });
  it("normalizes explicit phones and username case for deduplication", () => {
    expect(normalizeRecipient("+998 (90) 123-45-67")).toEqual({
      value: "+998901234567",
      type: "phone",
    });
    const result = previewRecipients(
      [
        ["username", "phone"],
        ["@Alice", "+998901234567"],
        ["@ALICE", "+998909876543"],
        ["not an address", "+998901111111"],
      ],
      0,
      "username",
      true
    );
    expect(result.valid).toEqual([{ value: "@alice", type: "username" }]);
    expect(result.duplicates).toBe(1);
    expect(result.invalid).toEqual([{ row: 4, value: "not an address" }]);
  });
  it("imports only the selected column and handles quoted CSV", () => {
    const rows = parseRecipientCsv(
      '\uFEFFname,chat_id\r\n"A, B",-1001234567890\r\n"C ""D""",123456789\r\n'
    );
    expect(rows[1]).toEqual(["A, B", "-1001234567890"]);
    expect(rows[2]).toEqual(['C "D"', "123456789"]);
    expect(
      previewRecipients(rows, 1, "chat_id", true).valid.map(item => item.value)
    ).toEqual(["-1001234567890", "123456789"]);
  });
  it("parses semicolon, tab and multiline fields without extracting other cells", () => {
    expect(parseRecipientCsv('name;phone\n"A\nB";+998901234567')).toEqual([
      ["name", "phone"],
      ["A\nB", "+998901234567"],
    ]);
    expect(parseRecipientCsv("name\tphone\nA\t+998901234567")[1]).toEqual([
      "A",
      "+998901234567",
    ]);
    expect(() => parseRecipientCsv('"unfinished')).toThrow();
  });
});

describe("safe preview renders user content as React nodes", () => {
  it("renders supported formatting and safe links", () => {
    const html = renderToStaticMarkup(
      createElement(MessagePreview, {
        message: '<b>Hello</b> <a href="https://example.com">link</a>',
        parseMode: "HTML",
      })
    );
    expect(html).toContain("<strong>Hello</strong>");
    expect(html).toContain('href="https://example.com/"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
  it("does not create elements from raw HTML in Markdown or unrecognised HTML", () => {
    for (const mode of ["HTML", "Markdown", "None"]) {
      const html = renderToStaticMarkup(
        createElement(MessagePreview, {
          message: '<img src=x onerror="alert(1)"><script>alert(1)</script>',
          parseMode: mode,
        })
      );
      expect(html).not.toContain("<img");
      expect(html).not.toContain("<script");
      expect(html).toContain("&lt;img");
    }
  });
  it("blocks JavaScript/data URLs and quote-breakout attributes", () => {
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,evil",
      "//evil.test",
      "file:///tmp/test",
    ])
      expect(safePreviewUrl(url)).toBeNull();
    const html = renderToStaticMarkup(
      createElement(MessagePreview, {
        message:
          "<a href='https://example.com\" onmouseover=\"alert(1)'>test</a>",
        parseMode: "HTML",
      })
    );
    expect(html).not.toMatch(/\sonmouseover="/);
    expect(html).not.toContain('<a href="https://example.com"');
    const bad = renderToStaticMarkup(
      createElement(MessagePreview, {
        message: "[click](javascript:alert)",
        parseMode: "Markdown",
      })
    );
    expect(bad).not.toContain("<a");
  });
});
