import { createHash, timingSafeEqual } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { closePool, getPool } from "../server/connection";
import {
  rehearseLatestBackup,
  restoreRehearsalEnvironment,
  runEncryptedBackup,
} from "../server/maintenance";

export const CLOUD_BACKUP_BUCKET = "tg-sender-backups";
export const CLOUD_BACKUP_MAX_BYTES = 48 * 1024 * 1024;
export const CLOUD_BACKUP_RETENTION = 7;
const ARCHIVE_NAME =
  /^tg-sender-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{32}\.tgbak$/;
const MAX_LIST_PAGES = 10;
const LIST_PAGE_SIZE = 100;
const LOCK_KEY = "tg-sender:cloud-archive";
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

class CloudBackupError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

type StorageConfig = { origin: string; serviceKey: string };
type Fetcher = typeof fetch;

export function cloudStorageConfig(
  environment: NodeJS.ProcessEnv = process.env
): StorageConfig {
  try {
    const url = new URL(environment.SUPABASE_URL ?? "");
    const serviceKey = environment.SUPABASE_SERVICE_ROLE_KEY;
    if (
      url.protocol !== "https:" ||
      !/^[a-z0-9]{20}\.supabase\.co$/.test(url.hostname) ||
      url.username ||
      url.password ||
      url.port ||
      (url.pathname !== "/" && url.pathname !== "") ||
      url.search ||
      url.hash ||
      !serviceKey ||
      serviceKey.length < 20
    )
      throw new Error("invalid configuration");
    return { origin: url.origin, serviceKey };
  } catch {
    throw new CloudBackupError("CLOUD_STORAGE_CONFIG_INVALID");
  }
}

function request(
  config: StorageConfig,
  path: string,
  init: RequestInit,
  fetcher: Fetcher
) {
  return fetcher(`${config.origin}/storage/v1/${path}`, {
    ...init,
    headers: {
      apikey: config.serviceKey,
      Authorization: `Bearer ${config.serviceKey}`,
      ...init.headers,
    },
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(120_000),
  });
}

async function boundedJson(response: Response) {
  if (!response.ok || !response.body)
    throw new CloudBackupError("CLOUD_STORAGE_READ_FAILED");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > 512 * 1024)
        throw new CloudBackupError("CLOUD_STORAGE_RESPONSE_TOO_LARGE");
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof CloudBackupError) throw error;
    throw new CloudBackupError("CLOUD_STORAGE_RESPONSE_INVALID");
  }
}

async function assertPrivateBucket(config: StorageConfig, fetcher: Fetcher) {
  const bucket = (await boundedJson(
    await request(config, `bucket/${CLOUD_BACKUP_BUCKET}`, {}, fetcher)
  )) as { id?: unknown; public?: unknown };
  if (bucket?.id !== CLOUD_BACKUP_BUCKET || bucket.public !== false)
    throw new CloudBackupError("CLOUD_BACKUP_BUCKET_MUST_BE_PRIVATE");
}

async function verifyStoredArchive(
  config: StorageConfig,
  name: string,
  bytes: Buffer,
  fetcher: Fetcher
) {
  let response: Response;
  try {
    response = await request(
      config,
      `object/authenticated/${CLOUD_BACKUP_BUCKET}/${name}`,
      {},
      fetcher
    );
  } catch {
    throw new CloudBackupError("CLOUD_ARCHIVE_VERIFICATION_UNAVAILABLE");
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new CloudBackupError("CLOUD_ARCHIVE_NOT_VERIFIED");
  }
  const hash = createHash("sha256");
  const reader = response.body.getReader();
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > bytes.length || size > CLOUD_BACKUP_MAX_BYTES)
        throw new CloudBackupError("CLOUD_ARCHIVE_CONTENT_MISMATCH");
      hash.update(next.value);
    }
    const expected = createHash("sha256").update(bytes).digest();
    if (size !== bytes.length || !timingSafeEqual(hash.digest(), expected))
      throw new CloudBackupError("CLOUD_ARCHIVE_CONTENT_MISMATCH");
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof CloudBackupError) throw error;
    throw new CloudBackupError("CLOUD_ARCHIVE_VERIFICATION_UNAVAILABLE");
  }
}

async function listArchives(config: StorageConfig, fetcher: Fetcher) {
  const names = new Set<string>();
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const entries = await boundedJson(
      await request(
        config,
        `object/list/${CLOUD_BACKUP_BUCKET}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prefix: "",
            limit: LIST_PAGE_SIZE,
            offset: page * LIST_PAGE_SIZE,
            sortBy: { column: "name", order: "asc" },
          }),
        },
        fetcher
      )
    );
    if (!Array.isArray(entries) || entries.length > LIST_PAGE_SIZE)
      throw new CloudBackupError("CLOUD_STORAGE_LIST_INVALID");
    for (const entry of entries) {
      if (typeof entry?.name === "string" && ARCHIVE_NAME.test(entry.name))
        names.add(entry.name);
    }
    if (entries.length < LIST_PAGE_SIZE) return [...names].sort();
  }
  throw new CloudBackupError("CLOUD_STORAGE_LIST_LIMIT_EXCEEDED");
}

async function retainArchives(
  config: StorageConfig,
  uploadedName: string,
  fetcher: Fetcher
) {
  const names = await listArchives(config, fetcher);
  if (!names.includes(uploadedName))
    throw new CloudBackupError("CLOUD_ARCHIVE_LIST_MISMATCH");
  const keep = new Set([
    uploadedName,
    ...names
      .filter(name => name !== uploadedName)
      .slice(-(CLOUD_BACKUP_RETENTION - 1)),
  ]);
  const obsolete = names.filter(name => !keep.has(name));
  if (!obsolete.length) return names.length;
  try {
    const response = await request(
      config,
      `object/${CLOUD_BACKUP_BUCKET}`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prefixes: obsolete }),
      },
      fetcher
    );
    await response.body?.cancel().catch(() => {});
  } catch {
    // A timeout can occur after deletion. Reconcile the listing; never repeat blindly.
  }
  const remaining = await listArchives(config, fetcher);
  if (
    !remaining.includes(uploadedName) ||
    remaining.length > CLOUD_BACKUP_RETENTION ||
    obsolete.some(name => remaining.includes(name))
  )
    throw new CloudBackupError("CLOUD_ARCHIVE_RETENTION_FAILED");
  return remaining.length;
}

/** Upload immutable encrypted bytes, read them back, then prune only our archive names. */
export async function archiveToCloud(
  name: string,
  bytes: Buffer,
  config: StorageConfig,
  fetcher: Fetcher = fetch
) {
  if (!ARCHIVE_NAME.test(name))
    throw new CloudBackupError("CLOUD_ARCHIVE_NAME_INVALID");
  if (
    bytes.length < 40 ||
    bytes.length > CLOUD_BACKUP_MAX_BYTES ||
    !bytes.subarray(0, 8).equals(Buffer.from("TGSBKP01"))
  )
    throw new CloudBackupError("CLOUD_ARCHIVE_SIZE_OR_FORMAT_INVALID");
  await assertPrivateBucket(config, fetcher);
  try {
    const response = await request(
      config,
      `object/${CLOUD_BACKUP_BUCKET}/${name}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "x-upsert": "false",
          "Cache-Control": "no-store",
        },
        body: new Uint8Array(bytes),
      },
      fetcher
    );
    await response.body?.cancel().catch(() => {});
  } catch {
    // The provider may already have committed this write. GET reconciles its result.
  }
  await verifyStoredArchive(config, name, bytes, fetcher);
  return {
    verified: true as const,
    bytes: bytes.length,
    retained: await retainArchives(config, name, fetcher),
  };
}

async function readCreatedArchive(name: string) {
  if (!ARCHIVE_NAME.test(name))
    throw new CloudBackupError("CLOUD_ARCHIVE_NAME_INVALID");
  const root = await realpath(PROJECT_ROOT);
  const directory = await realpath(join(root, ".runtime", "backups"));
  const path = await realpath(join(directory, name));
  const directoryRelative = relative(root, directory);
  if (
    !directoryRelative ||
    directoryRelative.startsWith("..") ||
    isAbsolute(directoryRelative) ||
    dirname(path) !== directory
  )
    throw new CloudBackupError("CLOUD_ARCHIVE_PATH_INVALID");
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > CLOUD_BACKUP_MAX_BYTES)
    throw new CloudBackupError("CLOUD_ARCHIVE_SIZE_OR_FORMAT_INVALID");
  return readFile(path);
}

export async function runCloudBackup() {
  const client = await getPool().connect();
  const controller = new AbortController();
  let locked = false;
  let broken = false;
  const onError = () => {
    broken = true;
    controller.abort();
  };
  client.on("error", onError);
  try {
    locked = (
      await client.query(
        "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",
        [LOCK_KEY]
      )
    ).rows[0].locked;
    if (!locked) return { worked: false as const };
    await client.query(
      "INSERT INTO maintenance_jobs(name,status,last_started_at) VALUES ('cloud_archive','RUNNING',now()) ON CONFLICT(name) DO UPDATE SET status='RUNNING',last_started_at=now(),last_error=NULL"
    );
    try {
      const config = cloudStorageConfig();
      if (!process.env.RESTORE_REHEARSAL_DATABASE_URL)
        throw new CloudBackupError("CLOUD_REHEARSAL_LOCAL_TARGET_REQUIRED");
      restoreRehearsalEnvironment();
      const backup = await runEncryptedBackup({ signal: controller.signal });
      if (!backup.worked)
        throw new CloudBackupError("CLOUD_SOURCE_BACKUP_BUSY");
      await rehearseLatestBackup({
        backupFile: backup.file,
        signal: controller.signal,
      });
      const scopedFetch: Fetcher = (input, init) =>
        fetch(input, {
          ...init,
          signal: init?.signal
            ? AbortSignal.any([init.signal, controller.signal])
            : controller.signal,
        });
      const result = await archiveToCloud(
        backup.file,
        await readCreatedArchive(backup.file),
        config,
        scopedFetch
      );
      await client.query(
        "UPDATE maintenance_jobs SET status='SUCCEEDED',last_finished_at=now(),last_success_at=now(),next_run_at=now()+interval '24 hours',last_file=$1,last_bytes=$2,last_error=NULL,failure_count=0,last_rehearsal_at=now(),last_rehearsal_error=NULL WHERE name='cloud_archive'",
        [backup.file, result.bytes]
      );
      return { worked: true as const, ...result };
    } catch (error) {
      const code =
        error instanceof CloudBackupError ? error.code : "CLOUD_BACKUP_FAILED";
      await client
        .query(
          "UPDATE maintenance_jobs SET status='FAILED',last_finished_at=now(),next_run_at=now()+interval '24 hours',last_error=$1,failure_count=failure_count+1 WHERE name='cloud_archive'",
          [code]
        )
        .catch(() => {});
      throw new CloudBackupError(code);
    }
  } finally {
    if (locked && !broken)
      await client
        .query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [LOCK_KEY])
        .catch(() => {
          broken = true;
        });
    client.removeListener("error", onError);
    client.release(broken);
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    console.log(JSON.stringify(await runCloudBackup()));
  } catch (error) {
    console.error(
      error instanceof CloudBackupError ? error.code : "CLOUD_BACKUP_FAILED"
    );
    process.exitCode = 1;
  } finally {
    await closePool().catch(() => {
      console.error("CLOUD_BACKUP_DATABASE_CLOSE_FAILED");
      process.exitCode = 1;
    });
  }
}
