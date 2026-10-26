import { describe, it, expect } from "vitest";
import { safePhotoName, validatePhoto } from "./media";
import { PHOTO_MAX_BYTES } from "../shared/media";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1kAAAAASUVORK5CYII=";
describe("bounded private photo validation", () => {
  it("recognises raster content and fingerprints the exact bytes", () => {
    const result = validatePhoto(PNG, "image/png");
    expect(result).toMatchObject({
      width: 1,
      height: 1,
      mimeType: "image/png",
    });
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.bytes.equals(Buffer.from(PNG, "base64"))).toBe(true);
  });
  it("rejects MIME spoofing, SVG, URLs, invalid base64 and truncated PNG", () => {
    for (const [data, mime] of [
      [PNG, "image/jpeg"],
      [
        Buffer.from('<svg onload="alert(1)"></svg>').toString("base64"),
        "image/png",
      ],
      ["https://evil.invalid/a.png", "image/png"],
      [PNG + "\n", "image/png"],
      [PNG.slice(0, -8), "image/png"],
      ["!!!!", "image/png"],
    ])
      expect(() => validatePhoto(data, mime)).toThrow();
  });
  it("bounds decoded byte size and rejects enormous or ultra-wide dimensions", () => {
    expect(() =>
      validatePhoto(
        Buffer.alloc(PHOTO_MAX_BYTES + 1).toString("base64"),
        "image/png"
      )
    ).toThrow();
    for (const [width, height] of [
      [5000, 1],
      [4096, 1],
      [0, 1],
    ]) {
      const bytes = Buffer.from(PNG, "base64");
      bytes.writeUInt32BE(width, 16);
      bytes.writeUInt32BE(height, 20);
      expect(() =>
        validatePhoto(bytes.toString("base64"), "image/png")
      ).toThrow();
    }
  });
  it("normalises names to a raster extension and strips paths and controls", () => {
    expect(safePhotoName("../../evil.svg", "image/png")).toBe("evil.png");
    expect(safePhotoName("C:\\folder\\test\r\n.svg", "image/jpeg")).toBe(
      "test.jpg"
    );
    expect(
      safePhotoName("x".repeat(300) + ".png", "image/png").length
    ).toBeLessThanOrEqual(120);
  });
});
