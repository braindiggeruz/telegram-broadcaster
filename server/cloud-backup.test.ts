import { describe, expect, it, vi } from "vitest";
import {
  archiveToCloud,
  CLOUD_BACKUP_BUCKET,
  CLOUD_BACKUP_MAX_BYTES,
  cloudStorageConfig,
} from "../scripts/cloud-backup";
import { databasePoolConfig } from "./connection";
import { restoreRehearsalEnvironment } from "./maintenance";

const config = cloudStorageConfig({
  SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "synthetic-service-role-key-for-tests",
});
const archiveName = (day = 26, id = 0) =>
  `tg-sender-2026-10-${String(day).padStart(2, "0")}T02-17-00-000Z-${id.toString(16).padStart(32, "0")}.tgbak`;
const archiveBytes = () =>
  Buffer.concat([Buffer.from("TGSBKP01"), Buffer.alloc(64, 7)]);

function storageFixture(
  options: {
    uploadTimeout?: "before" | "after";
    corruptDownload?: boolean;
    publicBucket?: boolean;
    deleteTimeout?: boolean;
    failDelete?: boolean;
  } = {}
) {
  const objects = new Map<string, Buffer>();
  const deleted: string[][] = [];
  const fetcher = vi.fn(
    async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      expect(url.origin).toBe(config.origin);
      expect(init.redirect).toBe("error");
      expect(new Headers(init.headers).get("apikey")).toBe(config.serviceKey);
      const path = url.pathname.replace("/storage/v1/", "");
      if (path === `bucket/${CLOUD_BACKUP_BUCKET}`) {
        return Response.json({
          id: CLOUD_BACKUP_BUCKET,
          public: options.publicBucket ?? false,
        });
      }
      if (path === `object/list/${CLOUD_BACKUP_BUCKET}`) {
        const body = JSON.parse(String(init.body));
        expect(body.prefix).toBe("");
        return Response.json(
          [...objects.keys()]
            .sort()
            .slice(body.offset, body.offset + body.limit)
            .map(name => ({ name }))
        );
      }
      if (
        path === `object/${CLOUD_BACKUP_BUCKET}` &&
        init.method === "DELETE"
      ) {
        const names = JSON.parse(String(init.body)).prefixes as string[];
        deleted.push(names);
        if (!options.failDelete) for (const name of names) objects.delete(name);
        if (options.deleteTimeout) throw new Error("synthetic delete timeout");
        return Response.json({});
      }
      const authenticatedPrefix = `object/authenticated/${CLOUD_BACKUP_BUCKET}/`;
      if (path.startsWith(authenticatedPrefix)) {
        const bytes = objects.get(path.slice(authenticatedPrefix.length));
        if (!bytes) return new Response(null, { status: 404 });
        return new Response(
          new Uint8Array(
            options.corruptDownload ? Buffer.alloc(bytes.length, 8) : bytes
          )
        );
      }
      const uploadPrefix = `object/${CLOUD_BACKUP_BUCKET}/`;
      if (path.startsWith(uploadPrefix) && init.method === "POST") {
        expect(new Headers(init.headers).get("x-upsert")).toBe("false");
        if (options.uploadTimeout === "before")
          throw new Error("synthetic upload timeout");
        const name = path.slice(uploadPrefix.length);
        if (objects.has(name)) return new Response(null, { status: 409 });
        objects.set(name, Buffer.from(init.body as Uint8Array));
        if (options.uploadTimeout === "after")
          throw new Error("synthetic upload timeout");
        return Response.json({ Key: `${CLOUD_BACKUP_BUCKET}/${name}` });
      }
      throw new Error("Unexpected test request");
    }
  );
  const uploads = () =>
    fetcher.mock.calls.filter(
      ([input, init]) =>
        init?.method === "POST" &&
        String(input).includes(`/object/${CLOUD_BACKUP_BUCKET}/`)
    );
  return {
    objects,
    deleted,
    fetcher: fetcher as typeof fetch & typeof fetcher,
    uploads,
  };
}

describe("immutable encrypted cloud archives", () => {
  it("uploads once and verifies the downloaded bytes before declaring success", async () => {
    const storage = storageFixture();
    const bytes = archiveBytes();
    await expect(
      archiveToCloud(archiveName(), bytes, config, storage.fetcher)
    ).resolves.toEqual({
      verified: true,
      bytes: bytes.length,
      retained: 1,
    });
    expect(storage.uploads()).toHaveLength(1);
    expect(storage.objects.get(archiveName())).toEqual(bytes);
    expect(storage.deleted).toEqual([]);
  });

  it("reconciles an upload timeout with GET without repeating the write", async () => {
    const storage = storageFixture({ uploadTimeout: "after" });
    await expect(
      archiveToCloud(archiveName(), archiveBytes(), config, storage.fetcher)
    ).resolves.toMatchObject({ verified: true });
    expect(storage.uploads()).toHaveLength(1);
  });

  it("fails an unconfirmed upload timeout without retrying or pruning old backups", async () => {
    const storage = storageFixture({ uploadTimeout: "before" });
    await expect(
      archiveToCloud(archiveName(), archiveBytes(), config, storage.fetcher)
    ).rejects.toThrow("CLOUD_ARCHIVE_NOT_VERIFIED");
    expect(storage.uploads()).toHaveLength(1);
    expect(storage.deleted).toEqual([]);
  });

  it("rejects a hash mismatch and preserves previously retained archives", async () => {
    const storage = storageFixture({ corruptDownload: true });
    await expect(
      archiveToCloud(archiveName(), archiveBytes(), config, storage.fetcher)
    ).rejects.toThrow("CLOUD_ARCHIVE_CONTENT_MISMATCH");
    expect(storage.deleted).toEqual([]);
  });

  it("requires a private bucket before uploading any bytes", async () => {
    const storage = storageFixture({ publicBucket: true });
    await expect(
      archiveToCloud(archiveName(), archiveBytes(), config, storage.fetcher)
    ).rejects.toThrow("CLOUD_BACKUP_BUCKET_MUST_BE_PRIVATE");
    expect(storage.uploads()).toHaveLength(0);
  });

  it("retains seven valid archives and never deletes unrelated names or nested paths", async () => {
    const storage = storageFixture();
    for (let day = 1; day <= 10; day++)
      storage.objects.set(archiveName(day), archiveBytes());
    const unrelated = [
      "owner-notes.txt",
      `nested/${archiveName(1)}`,
      `../${archiveName(1)}`,
    ];
    for (const name of unrelated)
      storage.objects.set(name, Buffer.from("unrelated"));
    const result = await archiveToCloud(
      archiveName(),
      archiveBytes(),
      config,
      storage.fetcher
    );
    expect(result.retained).toBe(7);
    expect(storage.deleted).toEqual([
      [1, 2, 3, 4].map(day => archiveName(day)),
    ]);
    expect(unrelated.every(name => storage.objects.has(name))).toBe(true);
    expect(storage.objects.has(archiveName())).toBe(true);
  });

  it("reconciles an uncertain deletion by listing instead of repeating DELETE", async () => {
    const storage = storageFixture({ deleteTimeout: true });
    for (let day = 1; day <= 7; day++)
      storage.objects.set(archiveName(day), archiveBytes());
    await expect(
      archiveToCloud(archiveName(), archiveBytes(), config, storage.fetcher)
    ).resolves.toMatchObject({ retained: 7 });
    expect(storage.deleted).toHaveLength(1);
  });

  it("reports failed retention instead of falsely reporting a completed cloud backup", async () => {
    const storage = storageFixture({ failDelete: true });
    for (let day = 1; day <= 7; day++)
      storage.objects.set(archiveName(day), archiveBytes());
    await expect(
      archiveToCloud(archiveName(), archiveBytes(), config, storage.fetcher)
    ).rejects.toThrow("CLOUD_ARCHIVE_RETENTION_FAILED");
    expect(storage.deleted).toHaveLength(1);
  });

  it("caps archive size and forbids path traversal before making network requests", async () => {
    const storage = storageFixture();
    await expect(
      archiveToCloud(
        `../${archiveName()}`,
        archiveBytes(),
        config,
        storage.fetcher
      )
    ).rejects.toThrow("CLOUD_ARCHIVE_NAME_INVALID");
    await expect(
      archiveToCloud(
        archiveName(),
        Buffer.alloc(CLOUD_BACKUP_MAX_BYTES + 1),
        config,
        storage.fetcher
      )
    ).rejects.toThrow("CLOUD_ARCHIVE_SIZE_OR_FORMAT_INVALID");
    expect(storage.fetcher).not.toHaveBeenCalled();
  });

  it("bounds large listings and does not delete based on an incomplete inventory", async () => {
    const storage = storageFixture();
    for (let index = 0; index < 1000; index++)
      storage.objects.set(archiveName(1, index), archiveBytes());
    await expect(
      archiveToCloud(archiveName(), archiveBytes(), config, storage.fetcher)
    ).rejects.toThrow("CLOUD_STORAGE_LIST_LIMIT_EXCEEDED");
    expect(storage.deleted).toEqual([]);
    expect(
      storage.fetcher.mock.calls.filter(([input]) =>
        String(input).includes("/object/list/")
      )
    ).toHaveLength(10);
  });
});

describe("local cloud backup rehearsal target", () => {
  const source = {
    DATABASE_URL:
      "postgresql://source:synthetic@db.example/postgres?sslmode=require",
    DATABASE_SSL: "require",
    DATABASE_CA: "source-ca",
  };

  it("changes only the rehearsal environment and preserves the verified source configuration", () => {
    const configured = {
      ...source,
      RESTORE_REHEARSAL_DATABASE_URL:
        "postgresql://rehearsal:synthetic@127.0.0.1:5432/postgres",
    };
    const target = restoreRehearsalEnvironment(configured);
    expect(target.DATABASE_URL).toBe(configured.RESTORE_REHEARSAL_DATABASE_URL);
    expect(databasePoolConfig(target).ssl).toBe(false);
    expect(databasePoolConfig(configured).ssl).toEqual({
      rejectUnauthorized: true,
      ca: "source-ca",
    });
    expect(configured.DATABASE_SSL).toBe("require");
    expect(configured.DATABASE_CA).toBe("source-ca");
  });

  it("preserves existing local or remote default behavior when no override is present", () => {
    expect(restoreRehearsalEnvironment(source)).toEqual(source);
  });

  it("rejects remote, malformed, query-redirected and fragment-bearing override targets", () => {
    for (const target of [
      "postgresql://test:synthetic@db.example/postgres",
      "https://127.0.0.1/postgres",
      "postgresql://test:synthetic@127.0.0.1/postgres?host=db.example",
      "postgresql://test:synthetic@127.0.0.1/postgres?ssl=0",
      "postgresql://test:synthetic@127.0.0.1/postgres#fragment",
      "postgresql://127.0.0.1/postgres",
      "not-a-url",
    ])
      expect(() =>
        restoreRehearsalEnvironment({
          ...source,
          RESTORE_REHEARSAL_DATABASE_URL: target,
        })
      ).toThrow("RESTORE_REHEARSAL_TARGET_INVALID");
  });

  it("does not disclose configured secrets in storage validation errors", () => {
    expect(() =>
      cloudStorageConfig({
        SUPABASE_URL: "https://secret.example/?token=synthetic",
        SUPABASE_SERVICE_ROLE_KEY: "synthetic",
      })
    ).toThrow("CLOUD_STORAGE_CONFIG_INVALID");
  });
});
