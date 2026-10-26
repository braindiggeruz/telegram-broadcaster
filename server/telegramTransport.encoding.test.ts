import { describe, expect, it } from "vitest";
import { Api } from "telegram";
import bigInt from "big-integer";

describe("real GramJS upload request encoding", () => {
  it.each([1, 253, 254, 255, 128 * 1024, 1024 * 1024])(
    "serializes the precise Buffer subarray and TL length/padding for %i bytes",
    length => {
      const backing = Buffer.alloc(length + 18, 0xcd);
      backing.fill(0xab, 7, 7 + length);
      const bytes = backing.subarray(7, 7 + length);
      const operation = new Api.upload.SaveFilePart({
        fileId: bigInt("9223372036854775806"),
        filePart: 7,
        bytes,
      });
      const encoded = operation.getBytes();
      expect(Buffer.isBuffer(bytes)).toBe(true);
      expect(Buffer.isBuffer(encoded)).toBe(true);
      expect(encoded.readUInt32LE(0)).toBe(0xb304a621);
      expect(encoded.readBigInt64LE(4)).toBe(9223372036854775806n);
      expect(encoded.readInt32LE(12)).toBe(7);
      const payloadOffset = length < 254 ? 17 : 20;
      if (length < 254) expect(encoded[16]).toBe(length);
      else {
        expect(encoded[16]).toBe(254);
        expect(encoded.readUIntLE(17, 3)).toBe(length);
      }
      expect(
        encoded.subarray(payloadOffset, payloadOffset + length).equals(bytes)
      ).toBe(true);
      const padding = encoded.subarray(payloadOffset + length);
      expect(padding.length).toBeLessThan(4);
      expect(padding.equals(Buffer.alloc(padding.length))).toBe(true);
      expect(encoded.length % 4).toBe(0);
    }
  );

  it.each(["1", "9223372036854775807", "-1"])(
    "encodes the actual signed 64-bit file id %s without precision loss",
    fileId => {
      const operation = new Api.upload.SaveFilePart({
        fileId: bigInt(fileId),
        filePart: 0,
        bytes: Buffer.from([1]),
      });
      expect(operation.getBytes().readBigInt64LE(4)).toBe(BigInt(fileId));
    }
  );

  it("encodes the final photo request with the exact persisted random id", () => {
    const operation = new Api.messages.SendMedia({
      peer: new Api.InputPeerSelf(),
      media: new Api.InputMediaUploadedPhoto({
        file: new Api.InputFile({
          id: bigInt("9223372036854775806"),
          parts: 1,
          name: "photo.jpg",
          md5Checksum: "0123456789abcdef0123456789abcdef",
        }),
      }),
      message: "Synthetic caption",
      randomId: bigInt("9223372036854775805"),
    });
    const encoded = operation.getBytes();
    expect(Buffer.isBuffer(encoded)).toBe(true);
    expect(encoded.readUInt32LE(0)).toBe(Api.messages.SendMedia.CONSTRUCTOR_ID);
    expect(encoded.includes(Buffer.from("Synthetic caption"))).toBe(true);
    expect(encoded.readBigInt64LE(encoded.length - 8)).toBe(
      9223372036854775805n
    );
  });
});
