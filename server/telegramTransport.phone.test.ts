import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Api } from "telegram";
import bigInt from "big-integer";
import { createHash } from "node:crypto";
import { FloodWaitError } from "telegram/errors/index.js";
import { DeliveryError, type DeliveryRequest } from "./delivery/types";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  photo: vi.fn(),
  createClient: vi.fn(),
  connect: vi.fn(),
  destroy: vi.fn(),
  getInputEntity: vi.fn(),
  invoke: vi.fn(),
}));
vi.mock("./db", () => ({
  getMtprotoSession: mocks.session,
  getBotSettings: vi.fn(),
}));
vi.mock("./media", () => ({ getPhotoBytes: mocks.photo }));
vi.mock("./mtproto", () => ({ createClient: mocks.createClient }));
import { telegramTransport } from "./telegramTransport";

const sessionString = "synthetic-phone-resolution-session";
const randomId = "9223372036854775806";
const userId = bigInt("71001");
const accessHash = bigInt("123456789012345");
const request = (
  overrides: Partial<DeliveryRequest> = {}
): DeliveryRequest => ({
  ownerId: 1,
  kind: "mtproto",
  recipient: "phone:+19990000000",
  message: "Synthetic text",
  parseMode: null,
  deliveryId: "synthetic-phone-delivery",
  randomId,
  signal: new AbortController().signal,
  senderFingerprint: createHash("sha256").update(sessionString).digest("hex"),
  ...overrides,
});
const resolved = (
  users: Api.TypeUser[] = [
    new Api.User({ id: userId, accessHash, firstName: "Synthetic" }),
  ],
  peer: Api.TypePeer = new Api.PeerUser({ userId })
) => new Api.contacts.ResolvedPeer({ peer, users, chats: [] });
const confirmed = () =>
  new Api.Updates({
    updates: [new Api.UpdateMessageID({ id: 123, randomId: bigInt(randomId) })],
    users: [],
    chats: [],
    date: 1,
    seq: 1,
  });
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("LIVE_SEND_ENABLED", "true");
  mocks.session.mockResolvedValue({ isActive: true, sessionString });
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
  mocks.invoke.mockImplementation(async operation => {
    if (operation instanceof Api.contacts.ResolvePhone) return resolved();
    if (operation instanceof Api.upload.SaveFilePart) return true;
    return confirmed();
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("official phone resolution without contact-book changes", () => {
  it.each([false, true])(
    "accepts a matching self user without an access hash, photo=%s",
    async withPhoto => {
      mocks.invoke.mockResolvedValueOnce(
        resolved([new Api.User({ id: userId, self: true })])
      );
      let attachment: Partial<DeliveryRequest> = {};
      if (withPhoto) {
        const bytes = Buffer.alloc(1024, 0xab);
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const photoId = "6c411d5f-bb6a-4c30-843c-a2e203201b1f";
        mocks.photo.mockResolvedValue({
          bytes,
          attachment: {
            id: photoId,
            sha256,
            size: bytes.length,
            mimeType: "image/jpeg",
          },
        });
        attachment = { photoId, photoSha256: sha256 };
      }
      await expect(
        telegramTransport.send(request(attachment))
      ).resolves.toEqual({ messageId: "123" });
      const send = mocks.invoke.mock.calls.at(-1)![0];
      expect(send).toBeInstanceOf(
        withPhoto ? Api.messages.SendMedia : Api.messages.SendMessage
      );
      expect(send.peer).toBeInstanceOf(Api.InputPeerSelf);
      expect(send.randomId.toString()).toBe(randomId);
      expect(mocks.getInputEntity).not.toHaveBeenCalled();
    }
  );

  it("resolves a non-contact then sends to the matching user with its access hash", async () => {
    await expect(telegramTransport.send(request())).resolves.toEqual({
      messageId: "123",
    });
    expect(mocks.getInputEntity).not.toHaveBeenCalled();
    const operations = mocks.invoke.mock.calls.map(([operation]) => operation);
    expect(operations).toHaveLength(2);
    expect(operations[0]).toBeInstanceOf(Api.contacts.ResolvePhone);
    expect(operations[0].phone).toBe("+19990000000");
    expect(operations[1]).toBeInstanceOf(Api.messages.SendMessage);
    expect(operations[1].peer).toBeInstanceOf(Api.InputPeerUser);
    expect(operations[1].peer.userId.toString()).toBe(userId.toString());
    expect(operations[1].peer.accessHash.toString()).toBe(
      accessHash.toString()
    );
    expect(operations[1].randomId.toString()).toBe(randomId);
    expect(
      operations.some(
        operation =>
          operation instanceof Api.contacts.ImportContacts ||
          operation instanceof Api.contacts.DeleteContacts ||
          operation instanceof Api.contacts.GetContacts
      )
    ).toBe(false);
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
  });

  it.each([
    "PHONE_NOT_OCCUPIED",
    "USER_PRIVACY_RESTRICTED",
    "PHONE_NUMBER_INVALID",
  ])("never sends or retries when lookup returns %s", async errorMessage => {
    mocks.invoke.mockRejectedValueOnce({ errorMessage });
    await expect(telegramTransport.send(request())).rejects.toMatchObject({
      category: "recipient",
      code: errorMessage,
    });
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.getInputEntity).not.toHaveBeenCalled();
  });

  it.each([
    resolved([], new Api.PeerChat({ chatId: bigInt(99) })),
    resolved([new Api.User({ id: bigInt(999), accessHash })]),
    resolved([new Api.UserEmpty({ id: userId })]),
    resolved([new Api.User({ id: userId, accessHash, min: true })]),
    resolved([new Api.User({ id: userId, accessHash, deleted: true })]),
  ])("fails closed for an unusable returned user", async value => {
    mocks.invoke.mockResolvedValueOnce(value);
    await expect(telegramTransport.send(request())).rejects.toMatchObject({
      category: "recipient",
      code: "MTPROTO_PHONE_NOT_RESOLVED",
    });
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, bigInt.zero])(
    "does not guess a missing access hash",
    async value => {
      mocks.invoke.mockResolvedValueOnce(
        resolved([new Api.User({ id: userId, accessHash: value })])
      );
      await expect(telegramTransport.send(request())).rejects.toMatchObject({
        category: "recipient",
        code: "MTPROTO_PHONE_ACCESS_HASH_MISSING",
      });
      expect(mocks.invoke).toHaveBeenCalledTimes(1);
    }
  );

  it("preserves a server FloodWait without retrying the lookup", async () => {
    mocks.invoke.mockRejectedValueOnce(
      new FloodWaitError({
        capture: 2090,
        request: new Api.contacts.ResolvePhone({ phone: "+19990000000" }),
      })
    );
    await expect(telegramTransport.send(request())).rejects.toMatchObject({
      category: "cooldown",
      code: "FLOOD_WAIT",
      retryAfterSeconds: 2090,
    });
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it("does not issue another lookup or any message after a lookup network failure", async () => {
    mocks.invoke.mockRejectedValueOnce(new Error("synthetic-disconnect"));
    await expect(telegramTransport.send(request())).rejects.toMatchObject({
      category: "transient",
      code: "MTPROTO_RESOLUTION_UNAVAILABLE",
      retryAfterSeconds: 60,
    });
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it.each(["connect", "resolve_phone"] as const)(
    "logs only safe metadata for a private unknown failure at %s",
    async stage => {
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      const secret = "synthetic-private-phone-session-request-value";
      try {
        const error = Object.assign(new Error(secret), {
          name: secret,
          errorMessage: secret,
          code: secret,
          stack: secret,
          phone: secret,
          sessionString: secret,
          bytes: Buffer.from(secret),
        });
        if (stage === "connect") mocks.connect.mockRejectedValueOnce(error);
        else mocks.invoke.mockRejectedValueOnce(error);
        await expect(telegramTransport.send(request())).rejects.toBeInstanceOf(
          Error
        );
        expect(warning).toHaveBeenCalledTimes(1);
        expect(warning).toHaveBeenCalledWith(
          JSON.stringify({
            event: "telegram_phone_resolution_failure",
            stage,
            reason: "UNKNOWN",
            name: "UNKNOWN",
          })
        );
        expect(JSON.stringify(warning.mock.calls)).not.toContain(secret);
        expect(JSON.stringify(warning.mock.calls)).not.toContain(
          "+19990000000"
        );
        expect(JSON.stringify(warning.mock.calls)).not.toContain(sessionString);
        expect(mocks.invoke).toHaveBeenCalledTimes(stage === "connect" ? 0 : 1);
        expect(mocks.destroy).toHaveBeenCalledTimes(1);
      } finally {
        warning.mockRestore();
      }
    }
  );

  it.each(["connect", "resolve_phone"] as const)(
    "identifies SDK reconnect exhaustion at %s without retrying or sending",
    async stage => {
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const error = "Maximum reconnection retries reached. Aborting!";
        if (stage === "connect") mocks.connect.mockRejectedValueOnce(error);
        else mocks.invoke.mockRejectedValueOnce(error);
        await expect(telegramTransport.send(request())).rejects.toBeInstanceOf(
          Error
        );
        expect(warning).toHaveBeenCalledTimes(1);
        expect(warning).toHaveBeenCalledWith(
          JSON.stringify({
            event: "telegram_phone_resolution_failure",
            stage,
            reason: "RECONNECT_EXHAUSTED",
            name: "UNKNOWN",
          })
        );
        expect(mocks.invoke).toHaveBeenCalledTimes(stage === "connect" ? 0 : 1);
      } finally {
        warning.mockRestore();
      }
    }
  );

  it("does not mislabel an uncertain final send as phone resolution failure", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      mocks.invoke
        .mockResolvedValueOnce(resolved())
        .mockRejectedValueOnce({ code: "ETIMEDOUT" });
      await expect(
        telegramTransport.send(request())
      ).rejects.not.toBeInstanceOf(DeliveryError);
      expect(warning).not.toHaveBeenCalled();
      expect(mocks.invoke).toHaveBeenCalledTimes(2);
    } finally {
      warning.mockRestore();
    }
  });

  it("does not retry an uncertain final message result", async () => {
    mocks.invoke
      .mockResolvedValueOnce(resolved())
      .mockRejectedValueOnce(new Error("synthetic-disconnect"));
    await expect(telegramTransport.send(request())).rejects.not.toBeInstanceOf(
      DeliveryError
    );
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(mocks.invoke.mock.calls[1][0]).toBeInstanceOf(
      Api.messages.SendMessage
    );
  });

  it("never sends when cancellation arrives while resolving the phone", async () => {
    const controller = new AbortController();
    mocks.invoke.mockImplementationOnce(async () => {
      controller.abort();
      return resolved();
    });
    await expect(
      telegramTransport.send(request({ signal: controller.signal }))
    ).rejects.not.toBeInstanceOf(DeliveryError);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.destroy).toHaveBeenCalled();
  });

  it("retains the approved photo and persisted randomId on the resolved peer", async () => {
    const bytes = Buffer.alloc(1024, 0xab);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const photoId = "6c411d5f-bb6a-4c30-843c-a2e203201b1f";
    mocks.photo.mockResolvedValue({
      bytes,
      attachment: {
        id: photoId,
        sha256,
        size: bytes.length,
        mimeType: "image/jpeg",
      },
    });
    await telegramTransport.send(request({ photoId, photoSha256: sha256 }));
    const operations = mocks.invoke.mock.calls.map(([operation]) => operation);
    expect(operations).toHaveLength(3);
    expect(operations[0]).toBeInstanceOf(Api.contacts.ResolvePhone);
    expect(operations[1]).toBeInstanceOf(Api.upload.SaveFilePart);
    expect(operations[2]).toBeInstanceOf(Api.messages.SendMedia);
    expect(operations[2].peer.userId.toString()).toBe(userId.toString());
    expect(operations[2].randomId.toString()).toBe(randomId);
  });

  it.each(["username:recipient", "chat:71001"])(
    "keeps the existing %s path",
    async recipient => {
      await telegramTransport.send(request({ recipient }));
      expect(mocks.getInputEntity).toHaveBeenCalledTimes(1);
      expect(mocks.invoke).toHaveBeenCalledTimes(1);
      expect(mocks.invoke.mock.calls[0][0]).toBeInstanceOf(
        Api.messages.SendMessage
      );
    }
  );
});
