import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";
import { deflateSync } from "node:zlib";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { appRouter } from "./routers";
import { closePool, databasePoolConfig, getPool } from "./connection";
import { DeliveryService, runWorkerOnce } from "./delivery";
import { getPhotoBytes, getPhotoMetadata } from "./media";

const url = process.env.TEST_DATABASE_URL;
function pngFixture(second = false) {
  const chunk = (kind: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(kind), data]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const header = Buffer.alloc(4),
      footer = Buffer.alloc(4);
    header.writeUInt32BE(data.length);
    footer.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([header, body, footer]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk(
      "IDAT",
      deflateSync(
        Buffer.from(second ? [0, 0, 128, 255, 255] : [0, 255, 128, 0, 255])
      )
    ),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

describe.skipIf(!url)("photo campaign snapshots on isolated PostgreSQL", () => {
  const schema = `photo_campaign_test_${randomUUID().replaceAll("-", "")}`;
  const ownerId = 87001;
  const otherId = 87002;
  let admin: Pool, pool: Pool, service: DeliveryService;
  let owner: ReturnType<typeof appRouter.createCaller>;
  let other: ReturnType<typeof appRouter.createCaller>;
  const context = (id: number) => ({
    req: {
      headers: { origin: "http://127.0.0.1:3037" },
      ip: "127.0.0.1",
    } as any,
    res: {} as any,
    user: {
      id,
      openId: `photo-owner-${id}`,
      name: "Synthetic photo owner",
      email: null,
      role: "admin" as const,
      loginMethod: "password",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    },
  });
  beforeAll(async () => {
    admin = new Pool(
      databasePoolConfig({
        ...process.env,
        DATABASE_URL: url,
        DATABASE_SSL: "disable",
      })
    );
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const isolated = new URL(url!);
    isolated.searchParams.set("options", `-c search_path=${schema}`);
    vi.stubEnv("DATABASE_URL", isolated.toString());
    vi.stubEnv("DATABASE_SSL", "disable");
    vi.stubEnv("LIVE_SEND_ENABLED", "false");
    vi.stubEnv("APP_ORIGIN", "http://127.0.0.1:3037");
    vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 67).toString("base64"));
    pool = getPool();
    await pool.query(
      (await readFile("drizzle/0000_massive_chamber.sql", "utf8")).replaceAll(
        '"public".',
        `"${schema}".`
      )
    );
    for (const file of (await readdir("migrations"))
      .filter(name => name.endsWith(".sql"))
      .sort())
      await pool.query(await readFile(`migrations/${file}`, "utf8"));
    await pool.query('INSERT INTO users(id,"openId") VALUES($1,$2),($3,$4)', [
      ownerId,
      `photo-owner-${ownerId}`,
      otherId,
      `photo-owner-${otherId}`,
    ]);
    owner = appRouter.createCaller(context(ownerId));
    other = appRouter.createCaller(context(otherId));
    service = new DeliveryService(pool);
  }, 30000);
  beforeEach(async () => {
    await pool.query(
      "TRUNCATE delivery_resolutions,delivery_attempts,deliveries,delivery_campaigns,contact_delivery_controls,sender_controls,contact_permissions,campaign_snapshots,audit_events,mtproto_broadcasts,broadcasts,message_drafts,message_media,recipient_lists RESTART IDENTITY CASCADE"
    );
  });
  afterAll(async () => {
    await closePool();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
    vi.unstubAllEnvs();
  });
  async function photo(caller = owner, second = false) {
    const bytes = pngFixture(second);
    return caller.media.uploadPhoto({
      name: second ? "second.png" : "first.png",
      mimeType: "image/png",
      dataBase64: bytes.toString("base64"),
    });
  }
  async function audience() {
    return owner.recipients.upload({
      name: "Synthetic opted-in photo audience",
      content: '["123456701"]',
      fileType: "json",
      consentSource: "photo integration explicit optin",
      consentConfirmed: true,
      permissionTransport: "mtproto",
    });
  }
  const input = (listId: number, photoId?: string) => ({
    name: "Photo campaign",
    message: "",
    photoId,
    parseMode: "None" as const,
    delaySeconds: 3,
    isDryRun: true,
    recipientListId: listId,
    requestKey: "photo-request",
  });

  it("deduplicates owner uploads, returns metadata only and decrypts bytes only for their owner", async () => {
    const first = await photo();
    const repeated = await photo();
    expect(repeated.id).toBe(first.id);
    const metadata = await getPhotoMetadata(ownerId, first.id);
    expect(metadata).toEqual(first);
    expect(metadata).not.toHaveProperty("content_encrypted");
    expect(metadata).not.toHaveProperty("dataBase64");
    expect((await getPhotoBytes(ownerId, first.id)).bytes).toEqual(
      pngFixture()
    );
    expect(await getPhotoMetadata(otherId, first.id)).toBeNull();
    await expect(getPhotoBytes(otherId, first.id)).rejects.toThrow(
      "PHOTO_CONTENT_UNAVAILABLE"
    );
    const ownOther = await photo(other);
    expect(ownOther.id).not.toBe(first.id);
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM message_media")).rows[0]
        .n
    ).toBe(2);
  });

  it("persists an owner-scoped photo draft and preserves optimistic version checks and removal", async () => {
    const attachment = await photo();
    const saved = await owner.draft.save({
      key: "mtproto",
      message: "Caption",
      parseMode: "None",
      photoId: attachment.id,
    });
    expect(saved).toMatchObject({
      photoId: attachment.id,
      photo: attachment,
      version: 1,
    });
    expect(await owner.draft.get({ key: "mtproto" })).toMatchObject({
      photoId: attachment.id,
      photo: attachment,
    });
    await expect(
      owner.draft.save({
        key: "mtproto",
        message: "Stale",
        parseMode: "None",
        photoId: null,
        expectedVersion: 0,
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      other.draft.save({
        key: "mtproto",
        message: "Foreign",
        parseMode: "None",
        photoId: attachment.id,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      owner.draft.save({
        key: "bot",
        message: "Unsupported",
        parseMode: "None",
        photoId: attachment.id,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const removed = await owner.draft.save({
      key: "mtproto",
      message: "Text",
      parseMode: "None",
      photoId: null,
      expectedVersion: 1,
    });
    expect(removed).toMatchObject({ photoId: null, photo: null, version: 2 });
  });

  it("rejects foreign images, oversized captions and bot photos before campaign writes", async () => {
    const list = await audience();
    const attachment = await photo(other);
    await expect(
      owner.mtproto.createBroadcast(input(list.id, attachment.id))
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      owner.mtproto.createBroadcast({
        ...input(list.id, attachment.id),
        message: "a".repeat(1025),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      owner.broadcast.create({
        ...input(list.id, attachment.id),
        message: "Caption",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(
      (await pool.query("SELECT * FROM campaign_snapshots")).rowCount
    ).toBe(0);
    expect(
      (await pool.query("SELECT * FROM mtproto_broadcasts")).rowCount
    ).toBe(0);
  });

  it("pins a photo-only campaign, deduplicates retries and ignores later draft changes", async () => {
    const list = await audience();
    const first = await photo();
    const second = await photo(owner, true);
    const campaign = await owner.mtproto.createBroadcast(
      input(list.id, first.id)
    );
    const retry = await owner.mtproto.createBroadcast(input(list.id, first.id));
    expect(retry.id).toBe(campaign.id);
    await expect(
      owner.mtproto.createBroadcast(input(list.id, second.id))
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await owner.draft.save({
      key: "mtproto",
      message: "New draft",
      parseMode: "None",
      photoId: second.id,
    });
    await owner.mtproto.launchBroadcast({ id: campaign.id });
    const queue = (
      await pool.query(
        "SELECT message,photo_id,photo_sha256 FROM delivery_campaigns"
      )
    ).rows[0];
    expect(queue).toMatchObject({
      message: "",
      photo_id: first.id,
      photo_sha256: first.sha256,
    });
    const detail = await owner.mtproto.getBroadcast({ id: campaign.id });
    expect(detail).toMatchObject({ photoId: first.id, photo: first });
    expect(detail).not.toHaveProperty("content_encrypted");
    const send = vi.fn(async () => ({ messageId: "never" }));
    await runWorkerOnce({ pool, transport: { send }, liveSendEnabled: false });
    expect(send).not.toHaveBeenCalled();
    expect(await owner.mtproto.getProgress({ id: campaign.id })).toMatchObject({
      dryRun: 1,
      accepted: 0,
      status: "completed",
    });
  });

  it("includes the photo in enqueue idempotency and passes the pinned digest and random ID to dispatch", async () => {
    const list = await audience();
    const first = await photo();
    const second = await photo(owner, true);
    const base = {
      ownerId,
      kind: "mtproto" as const,
      broadcastId: 912,
      message: "Caption",
      photoId: first.id,
      photoSha256: first.sha256,
      parseMode: "None" as const,
      recipients: ["123456701"],
      delaySeconds: 3,
      isDryRun: false,
    };
    await service.enqueueCampaign(base);
    await expect(
      service.enqueueCampaign({
        ...base,
        photoId: second.id,
        photoSha256: second.sha256,
      })
    ).rejects.toThrow("CAMPAIGN_SNAPSHOT_CONFLICT");
    await expect(
      service.enqueueCampaign({
        ...base,
        broadcastId: 913,
        photoSha256: "a".repeat(64),
      })
    ).rejects.toThrow("PHOTO_SNAPSHOT_CHANGED");
    await expect(
      service.enqueueCampaign({ ...base, broadcastId: 914, ownerId: otherId })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const send = vi.fn(async () => ({ messageId: "synthetic-photo-accepted" }));
    await runWorkerOnce({
      pool,
      transport: { send },
      liveSendEnabled: true,
      contactMinIntervalSeconds: 0,
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        photoId: first.id,
        photoSha256: first.sha256,
        message: "Caption",
        randomId: expect.stringMatching(/^[1-9]\d*$/),
      })
    );
    expect(
      (await pool.query("SELECT photo_id,photo_sha256 FROM delivery_campaigns"))
        .rows
    ).toEqual([{ photo_id: first.id, photo_sha256: first.sha256 }]);
    expect(list.id).toBeGreaterThan(0);
  });

  it("fails a dry-run when the approved photo digest is unavailable instead of dropping the image", async () => {
    const list = await audience();
    const attachment = await photo();
    const campaign = await owner.mtproto.createBroadcast(
      input(list.id, attachment.id)
    );
    await owner.mtproto.launchBroadcast({ id: campaign.id });
    await pool.query("UPDATE message_media SET sha256=$2 WHERE id=$1", [
      attachment.id,
      "c".repeat(64),
    ]);
    const send = vi.fn(async () => ({ messageId: "never" }));
    await runWorkerOnce({ pool, transport: { send }, liveSendEnabled: false });
    expect(send).not.toHaveBeenCalled();
    expect(await owner.mtproto.getProgress({ id: campaign.id })).toMatchObject({
      dryRun: 0,
      failed: 1,
    });
    expect(
      (await pool.query("SELECT last_error FROM deliveries")).rows[0].last_error
    ).toBe("PHOTO_SNAPSHOT_UNAVAILABLE");
  });
});
