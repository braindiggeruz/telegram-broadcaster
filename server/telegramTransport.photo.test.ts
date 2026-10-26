import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Api } from "telegram";
import bigInt from "big-integer";
import { createHash } from "node:crypto";
import type { DeliveryRequest } from "./delivery/types";
import { DeliveryError } from "./delivery/types";

const mocks = vi.hoisted(() => ({
  getPhotoBytes: vi.fn(),
  getMtprotoSession: vi.fn(),
  getBotSettings: vi.fn(),
  createClient: vi.fn(),
  connect: vi.fn(),
  destroy: vi.fn(),
  getInputEntity: vi.fn(),
  invoke: vi.fn(),
}));
vi.mock("./db", () => ({
  getMtprotoSession: mocks.getMtprotoSession,
  getBotSettings: mocks.getBotSettings,
}));
vi.mock("./media", () => ({ getPhotoBytes: mocks.getPhotoBytes }));
vi.mock("./mtproto", () => ({ createClient: mocks.createClient }));

import { telegramRequest, telegramTransport } from "./telegramTransport";

const sessionString = "synthetic-session-for-unit-test";
const bytes = Buffer.alloc(300 * 1024, 0xab);
const sha256 = createHash("sha256").update(bytes).digest("hex");
const photoId = "6c411d5f-bb6a-4c30-843c-a2e203201b1f";
const request = (
  overrides: Partial<DeliveryRequest> = {}
): DeliveryRequest => ({
  ownerId: 1,
  kind: "mtproto",
  recipient: "username:recipient",
  message: "<b>Подпись</b>",
  parseMode: "HTML",
  deliveryId: "synthetic-delivery",
  randomId: "9223372036854775806",
  signal: new AbortController().signal,
  senderFingerprint: createHash("sha256").update(sessionString).digest("hex"),
  photoId,
  photoSha256: sha256,
  ...overrides,
});
const confirmed = () =>
  new Api.Updates({
    updates: [
      new Api.UpdateMessageID({
        id: 123,
        randomId: bigInt("9223372036854775806"),
      }),
    ],
    users: [],
    chats: [],
    date: 1,
    seq: 1,
  });

beforeEach(() => {
  vi.stubEnv("LIVE_SEND_ENABLED", "true");
  vi.resetAllMocks();
  mocks.getMtprotoSession.mockResolvedValue({ isActive: true, sessionString });
  mocks.getPhotoBytes.mockResolvedValue({
    attachment: {
      id: photoId,
      sha256,
      mimeType: "image/jpeg",
      size: bytes.length,
      name: "image.jpg",
    },
    bytes,
  });
  mocks.connect.mockResolvedValue(undefined);
  mocks.destroy.mockResolvedValue(undefined);
  mocks.getInputEntity.mockResolvedValue(new Api.InputPeerSelf());
  mocks.createClient.mockResolvedValue({
    client: {
      connect: mocks.connect,
      destroy: mocks.destroy,
      getInputEntity: mocks.getInputEntity,
      invoke: mocks.invoke,
    },
  });
  mocks.invoke.mockImplementation(async operation =>
    operation instanceof Api.upload.SaveFilePart ? true : confirmed()
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("account photo transport", () => {
  it("uploads bounded parts and sends one parsed caption with the persisted randomId", async () => {
    await expect(telegramTransport.send(request())).resolves.toEqual({
      messageId: "123",
    });
    expect(mocks.getPhotoBytes).toHaveBeenCalledWith(1, photoId);
    const operations = mocks.invoke.mock.calls.map(([operation]) => operation);
    const parts = operations.filter(
      operation => operation instanceof Api.upload.SaveFilePart
    );
    expect(parts).toHaveLength(3);
    expect(parts.map(part => part.filePart)).toEqual([0, 1, 2]);
    expect(parts.every(part => part.bytes.length <= 128 * 1024)).toBe(true);
    expect(Buffer.concat(parts.map(part => part.bytes))).toEqual(bytes);
    expect(new Set(parts.map(part => part.fileId.toString())).size).toBe(1);
    const send = operations[3];
    expect(send).toBeInstanceOf(Api.messages.SendMedia);
    expect(send.randomId.toString()).toBe("9223372036854775806");
    expect(send.message).toBe("Подпись");
    expect(send.entities[0]).toBeInstanceOf(Api.MessageEntityBold);
    expect(send.media).toBeInstanceOf(Api.InputMediaUploadedPhoto);
    expect(send.media.file.parts).toBe(3);
    expect(send.media.file.id.toString()).toBe(parts[0].fileId.toString());
    expect(send.media.file.md5Checksum).toBe(
      createHash("md5").update(bytes).digest("hex")
    );
    expect(mocks.destroy).toHaveBeenCalled();
  });

  it("allows a photo without a caption", async () => {
    await telegramTransport.send(request({ message: "" }));
    const send = mocks.invoke.mock.calls.at(-1)![0];
    expect(send).toBeInstanceOf(Api.messages.SendMedia);
    expect(send.message).toBe("");
  });

  it("leaves the existing text path unchanged", async () => {
    await telegramTransport.send(
      request({ photoId: undefined, photoSha256: undefined })
    );
    expect(mocks.getPhotoBytes).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    const send = mocks.invoke.mock.calls[0][0];
    expect(send).toBeInstanceOf(Api.messages.SendMessage);
    expect(send.randomId.toString()).toBe("9223372036854775806");
    expect(send.message).toBe("Подпись");
    expect(send.noWebpage).toBe(true);
  });

  it.each([
    { photoSha256: undefined },
    { photoSha256: "0".repeat(64) },
    { photoId: undefined },
  ])(
    "rejects an unapproved attachment before connecting: %j",
    async overrides => {
      await expect(
        telegramTransport.send(request(overrides))
      ).rejects.toMatchObject({
        category: "content",
        code: "PHOTO_ATTACHMENT_CHANGED",
      });
      expect(mocks.connect).not.toHaveBeenCalled();
      expect(mocks.invoke).not.toHaveBeenCalled();
    }
  );

  it("rejects modified bytes even if stored metadata still matches", async () => {
    mocks.getPhotoBytes.mockResolvedValueOnce({
      attachment: { sha256, size: bytes.length, mimeType: "image/jpeg" },
      bytes: Buffer.alloc(bytes.length),
    });
    await expect(telegramTransport.send(request())).rejects.toMatchObject({
      category: "content",
      code: "PHOTO_ATTACHMENT_CHANGED",
    });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("rejects an overlong raw caption before loading/uploading the photo", async () => {
    await expect(
      telegramTransport.send(request({ message: "a".repeat(1025) }))
    ).rejects.toMatchObject({
      category: "content",
      code: "MEDIA_CAPTION_TOO_LONG",
    });
    expect(mocks.getPhotoBytes).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it.each(["PHOTO_CONTENT_UNAVAILABLE", "PHOTO_INTEGRITY_FAILED"])(
    "stops an unavailable or corrupt attachment before connecting: %s",
    async code => {
      mocks.getPhotoBytes.mockRejectedValueOnce(new Error(code));
      await expect(telegramTransport.send(request())).rejects.toMatchObject({
        category: "content",
        code: "PHOTO_UNAVAILABLE",
      });
      expect(mocks.connect).not.toHaveBeenCalled();
      expect(mocks.invoke).not.toHaveBeenCalled();
    }
  );

  it("retains a temporary photo store failure as safe pre-dispatch retry", async () => {
    mocks.getPhotoBytes.mockRejectedValueOnce(
      new Error("synthetic db disconnect")
    );
    await expect(telegramTransport.send(request())).rejects.toMatchObject({
      category: "transient",
      code: "PHOTO_LOAD_UNAVAILABLE",
    });
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("never connects or dispatches when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      telegramTransport.send(request({ signal: controller.signal }))
    ).rejects.not.toBeInstanceOf(DeliveryError);
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.destroy).toHaveBeenCalled();
  });

  it("stops before SendMedia when aborted during a part upload", async () => {
    const controller = new AbortController();
    mocks.invoke.mockImplementationOnce(async () => {
      controller.abort();
      return true;
    });
    await expect(
      telegramTransport.send(request({ signal: controller.signal }))
    ).rejects.not.toBeInstanceOf(DeliveryError);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke.mock.calls[0][0]).toBeInstanceOf(
      Api.upload.SaveFilePart
    );
    expect(mocks.destroy).toHaveBeenCalled();
  });

  it("retains a server FloodWait without retrying or sending a message", async () => {
    mocks.invoke.mockRejectedValueOnce({
      errorMessage: "FLOOD_WAIT_123",
      seconds: 123,
    });
    await expect(telegramTransport.send(request())).rejects.toMatchObject({
      category: "cooldown",
      code: "FLOOD_WAIT",
      retryAfterSeconds: 123,
    });
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it("marks upload network failure transient because SendMedia was never issued", async () => {
    mocks.invoke.mockRejectedValueOnce(new Error("synthetic disconnect"));
    await expect(telegramTransport.send(request())).rejects.toMatchObject({
      category: "transient",
      code: "PHOTO_UPLOAD_UNAVAILABLE",
    });
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it("never sends after an unaccepted upload part", async () => {
    mocks.invoke.mockResolvedValueOnce(false);
    await expect(telegramTransport.send(request())).rejects.toMatchObject({
      category: "transient",
      code: "PHOTO_UPLOAD_REJECTED",
    });
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it.each([
    "IMAGE_PROCESS_FAILED",
    "PHOTO_INVALID_DIMENSIONS",
    "MEDIA_CAPTION_TOO_LONG",
  ])(
    "classifies a confirmed photo rejection as content: %s",
    async errorMessage => {
      mocks.invoke.mockImplementation(async operation => {
        if (operation instanceof Api.upload.SaveFilePart) return true;
        throw { errorMessage };
      });
      await expect(telegramTransport.send(request())).rejects.toMatchObject({
        category: "content",
        code: errorMessage,
      });
    }
  );

  it.each(["network", "unconfirmed"])(
    "keeps a %s final-send outcome unknown and never resends",
    async outcome => {
      mocks.invoke.mockImplementation(async operation => {
        if (operation instanceof Api.upload.SaveFilePart) return true;
        if (outcome === "network") throw new Error("synthetic disconnect");
        return new Api.Updates({
          updates: [],
          chats: [],
          users: [],
          date: 1,
          seq: 1,
        });
      });
      await expect(
        telegramTransport.send(request())
      ).rejects.not.toBeInstanceOf(DeliveryError);
      expect(
        mocks.invoke.mock.calls.filter(
          ([operation]) => operation instanceof Api.messages.SendMedia
        )
      ).toHaveLength(1);
    }
  );

  it("rejects photo use through a bot explicitly", async () => {
    await expect(
      telegramTransport.send(request({ kind: "bot" }))
    ).rejects.toMatchObject({
      category: "content",
      code: "BOT_PHOTO_UNSUPPORTED",
    });
    expect(mocks.getBotSettings).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

describe("Telegram Bot HTTP redirect handling", () => {
  it("uses Worker-compatible manual redirects and rejects redirect responses", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("", { status: 302 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(telegramRequest("synthetic", "getMe")).rejects.toThrow(
      "TELEGRAM_RESPONSE_UNKNOWN"
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].redirect).toBe("manual");
  });
});
