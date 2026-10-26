import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Pool, type PoolClient } from "pg";
import { databasePoolConfig, getPool } from "./connection";

const MAGIC = Buffer.from("TGSBKP01");
const HEADER_BYTES = 20,
  TAG_BYTES = 16,
  MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ARCHIVE_NAME =
  /^tg-sender-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{32}\.tgbak$/;
const REHEARSAL_NAME = /^tg_sender_rehearsal_[a-f0-9]{24}$/;
const LOCK_KEY = "tg-sender:encrypted-daily-backup";

class MaintenanceError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
type Manifest = {
  format: 1;
  database: string;
  createdAt: string;
  postgresVersion: string;
  tableCounts: { table: string; count: string }[];
  migrations: { name: string; checksum: string }[];
};
type BackupResult = {
  file: string;
  bytes: number;
  createdAt: string;
  tables: number;
  migrations: number;
};
type Command = { process: ChildProcessWithoutNullStreams; done: Promise<void> };
type BackupOptions = { signal?: AbortSignal };
const safeError = (error: unknown) =>
  error instanceof MaintenanceError
    ? error.code
    : "MAINTENANCE_OPERATION_FAILED";
const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`;

function boundedSignal(signal?: AbortSignal) {
  const seconds = Number(process.env.BACKUP_TIMEOUT_SECONDS ?? 900);
  if (!Number.isInteger(seconds) || seconds < 60 || seconds > 7200)
    throw new MaintenanceError("BACKUP_TIMEOUT_CONFIG_INVALID");
  const timeout = AbortSignal.timeout(seconds * 1000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function backupKey() {
  const encoded = process.env.BACKUP_KEY_BASE64;
  if (!encoded || !/^[A-Za-z0-9+/]{43}=$/.test(encoded))
    throw new MaintenanceError("BACKUP_KEY_MISSING_OR_INVALID");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded)
    throw new MaintenanceError("BACKUP_KEY_MISSING_OR_INVALID");
  if (process.env.ENCRYPTION_KEY) {
    const appKey = Buffer.from(process.env.ENCRYPTION_KEY, "base64");
    if (appKey.length === key.length && timingSafeEqual(appKey, key))
      throw new MaintenanceError("BACKUP_KEY_MUST_BE_SEPARATE");
  }
  return key;
}

function databaseIdentity() {
  // Reuse strict URL/TLS validation, but never pass a URL or password through argv.
  databasePoolConfig();
  const url = new URL(
    process.env.DATABASE_URL || process.env.SUPABASE_DATABASE_URL!
  );
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (
    !/^[A-Za-z_][A-Za-z0-9_-]{0,62}$/.test(database) ||
    !url.username ||
    !url.hostname
  )
    throw new MaintenanceError("BACKUP_DATABASE_CONFIG_INVALID");
  return { url, database };
}

function inside(parent: string, child: string) {
  const path = relative(parent, child);
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}

function command(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal
): Command {
  if (signal?.aborted) throw new MaintenanceError("MAINTENANCE_ABORTED");
  const child = spawn(executable, args, {
    env,
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  // Drain diagnostics without logging them: libpq may include connection or record contents.
  child.stderr.resume();
  const abort = () => {
    child.kill();
  };
  signal?.addEventListener("abort", abort, { once: true });
  const done = new Promise<void>((resolveDone, reject) => {
    child.once("error", () =>
      reject(new MaintenanceError("POSTGRES_TOOL_UNAVAILABLE"))
    );
    child.once("close", code => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) reject(new MaintenanceError("MAINTENANCE_ABORTED"));
      else if (code === 0) resolveDone();
      else reject(new MaintenanceError("POSTGRES_TOOL_FAILED"));
    });
  });
  // Attach a handler immediately; callers await done alongside the stream pipeline.
  void done.catch(() => {});
  return { process: child, done };
}

async function privateDirectory() {
  const root = await realpath(PROJECT_ROOT);
  const runtime = resolve(root, ".runtime");
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const resolvedRuntime = await realpath(runtime);
  if (!inside(root, resolvedRuntime))
    throw new MaintenanceError("BACKUP_PATH_OUTSIDE_PROJECT");
  const path = resolve(resolvedRuntime, "backups");
  await mkdir(path, { recursive: true, mode: 0o700 });
  const resolved = await realpath(path);
  if (!inside(resolvedRuntime, resolved))
    throw new MaintenanceError("BACKUP_PATH_OUTSIDE_RUNTIME");
  if (process.platform === "win32") {
    const who = command(
      "whoami.exe",
      ["/user", "/fo", "csv", "/nh"],
      process.env
    );
    let output = "";
    for await (const chunk of who.process.stdout) output += String(chunk);
    await who.done;
    const sid = output.match(/S-1-\d+(?:-\d+)+/)?.[0];
    if (!sid) throw new MaintenanceError("BACKUP_ACL_IDENTITY_UNAVAILABLE");
    // Existing .runtime is already private. Reset removes inherited/existing broad grants,
    // then retain only this process identity and the OS service identity on the backup folder.
    const reset = command("icacls.exe", [resolved, "/reset"], process.env);
    reset.process.stdout.resume();
    await reset.done;
    const acl = command(
      "icacls.exe",
      [
        resolved,
        "/inheritance:r",
        "/grant:r",
        `*${sid}:(OI)(CI)F`,
        "*S-1-5-18:(OI)(CI)F",
      ],
      process.env
    );
    acl.process.stdout.resume();
    await acl.done;
  } else await chmod(resolved, 0o700);
  return resolved;
}

async function postgresEnvironment(
  directory: string,
  databaseOverride?: string
) {
  const { url, database } = databaseIdentity();
  const env: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
    "LANG",
    "LC_ALL",
  ]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  env.PGHOST = url.hostname.replace(/^\[|\]$/g, "");
  env.PGPORT = url.port || "5432";
  env.PGUSER = decodeURIComponent(url.username);
  env.PGPASSWORD = decodeURIComponent(url.password);
  env.PGDATABASE = databaseOverride ?? database;
  env.PGCONNECT_TIMEOUT = "10";
  env.PGSSLMODE =
    process.env.DATABASE_SSL === "disable" ? "disable" : "verify-full";
  let certificate: string | undefined;
  if (process.env.DATABASE_CA) {
    certificate = join(directory, `.postgres-ca-${randomUUID()}.crt`);
    await writeFile(
      certificate,
      process.env.DATABASE_CA.replace(/\\n/g, "\n"),
      { flag: "wx", mode: 0o600 }
    );
    env.PGSSLROOTCERT = certificate;
  }
  return {
    env,
    database,
    cleanup: async () => {
      if (certificate) await unlink(certificate).catch(() => {});
    },
  };
}

function postgresBinary(name: "pg_dump" | "pg_restore") {
  const directory =
    process.env.PG_BIN ||
    (process.platform === "win32"
      ? "C:/Program Files/PostgreSQL/17/bin"
      : undefined);
  return directory
    ? join(directory, process.platform === "win32" ? `${name}.exe` : name)
    : name;
}

async function snapshotManifest(
  client: PoolClient,
  database: string
): Promise<Manifest> {
  const identity = await client.query(
    "SELECT current_database() AS database,current_setting('server_version') AS version"
  );
  if (identity.rows[0].database !== database)
    throw new MaintenanceError("BACKUP_DATABASE_SCOPE_MISMATCH");
  const tables = await client.query(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"
  );
  const names = tables.rows.map(row => String(row.tablename));
  if (
    !["users", "deliveries", "delivery_campaigns", "app_migrations"].every(
      name => names.includes(name)
    )
  )
    throw new MaintenanceError("BACKUP_APPLICATION_SCHEMA_MISSING");
  const tableCounts: Manifest["tableCounts"] = [];
  for (const table of names) {
    const count = await client.query(
      `SELECT count(*)::text AS count FROM public.${quoteIdentifier(table)}`
    );
    tableCounts.push({ table, count: count.rows[0].count });
  }
  const migrations = await client.query(
    "SELECT name,checksum FROM app_migrations ORDER BY name"
  );
  return {
    format: 1,
    database,
    createdAt: new Date().toISOString(),
    postgresVersion: identity.rows[0].version,
    tableCounts,
    migrations: migrations.rows as Manifest["migrations"],
  };
}

async function createEncryptedArchive(
  pool: Pool,
  options: BackupOptions
): Promise<BackupResult> {
  const key = backupKey();
  const directory = await privateDirectory();
  const pg = await postgresEnvironment(directory);
  const client = await pool.connect();
  const stamp = new Date().toISOString().replaceAll(":", "-").replace(".", "-");
  const file = `tg-sender-${stamp}-${randomUUID().replaceAll("-", "")}.tgbak`;
  const target = join(directory, file),
    temporary = `${target}.partial`;
  let child: Command | undefined;
  let connectionBroken = false;
  const onConnectionError = () => {
    connectionBroken = true;
    child?.process.kill();
  };
  client.on("error", onConnectionError);
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout='15min'");
    const manifest = await snapshotManifest(client, pg.database);
    const snapshot = (
      await client.query("SELECT pg_export_snapshot() AS snapshot")
    ).rows[0].snapshot as string;
    const encoded = Buffer.from(JSON.stringify(manifest));
    if (encoded.length > MAX_MANIFEST_BYTES)
      throw new MaintenanceError("BACKUP_MANIFEST_TOO_LARGE");
    const size = Buffer.alloc(4);
    size.writeUInt32BE(encoded.length);
    const header = Buffer.concat([MAGIC, randomBytes(12)]);
    const cipher = createCipheriv(
      "aes-256-gcm",
      key,
      header.subarray(MAGIC.length)
    );
    cipher.setAAD(header);
    child = command(
      postgresBinary("pg_dump"),
      [
        "--format=custom",
        "--no-owner",
        "--no-privileges",
        "--lock-wait-timeout=30000",
        `--snapshot=${snapshot}`,
      ],
      pg.env,
      options.signal
    );
    child.process.stdin.end();
    const output = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
    output.write(header);
    const source = child.process.stdout;
    await Promise.all([
      pipeline(
        Readable.from(
          (async function* () {
            yield size;
            yield encoded;
            for await (const chunk of source) yield chunk;
          })()
        ),
        cipher,
        output
      ),
      child.done,
    ]);
    const handle = await open(temporary, "a");
    try {
      await handle.write(cipher.getAuthTag());
      await handle.sync();
    } finally {
      await handle.close();
    }
    await client.query("COMMIT");
    await rename(temporary, target);
    return {
      file,
      bytes: (await stat(target)).size,
      createdAt: manifest.createdAt,
      tables: manifest.tableCounts.length,
      migrations: manifest.migrations.length,
    };
  } catch (error) {
    child?.process.kill();
    await child?.done.catch(() => {});
    await client.query("ROLLBACK").catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  } finally {
    client.removeListener("error", onConnectionError);
    client.release(connectionBroken);
    key.fill(0);
    await pg.cleanup();
  }
}

async function backupJob(force: boolean, options: BackupOptions = {}) {
  const controller = new AbortController();
  const signal = boundedSignal(
    options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal
  );
  const pool = getPool(),
    client = await pool.connect();
  let locked = false;
  let connectionBroken = false;
  const onConnectionError = () => {
    connectionBroken = true;
    controller.abort();
  };
  client.on("error", onConnectionError);
  try {
    locked = (
      await client.query(
        "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",
        [LOCK_KEY]
      )
    ).rows[0].locked;
    if (!locked) return { worked: false as const };
    const job = await client.query(
      "SELECT next_run_at FROM maintenance_jobs WHERE name='daily_backup'"
    );
    if (!job.rowCount) throw new MaintenanceError("BACKUP_JOB_SCHEMA_MISSING");
    if (!force && new Date(job.rows[0].next_run_at) > new Date())
      return { worked: false as const };
    await client.query(
      "UPDATE maintenance_jobs SET status='RUNNING',last_started_at=now(),last_error=NULL WHERE name='daily_backup'"
    );
    try {
      const result = await createEncryptedArchive(pool, { signal });
      await client.query(
        "UPDATE maintenance_jobs SET status='SUCCEEDED',last_finished_at=now(),last_success_at=now(),next_run_at=now()+interval '24 hours',last_file=$1,last_bytes=$2,last_error=NULL,failure_count=0 WHERE name='daily_backup'",
        [result.file, result.bytes]
      );
      return { worked: true as const, ...result };
    } catch (error) {
      const code = safeError(error);
      await client
        .query(
          "UPDATE maintenance_jobs SET status='FAILED',last_finished_at=now(),next_run_at=now()+interval '1 hour',last_error=$1,failure_count=failure_count+1 WHERE name='daily_backup'",
          [code]
        )
        .catch(() => {});
      throw new MaintenanceError(code);
    }
  } finally {
    if (locked && !connectionBroken)
      await client
        .query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [LOCK_KEY])
        .catch(() => {
          connectionBroken = true;
        });
    client.removeListener("error", onConnectionError);
    client.release(connectionBroken);
  }
}

/** Separate background task; do not await this inside the delivery dispatch critical path. */
export const tickMaintenance = (options: BackupOptions = {}) =>
  backupJob(false, options);
export const runEncryptedBackup = (options: BackupOptions = {}) =>
  backupJob(true, options);
export async function getMaintenanceStatus() {
  return (
    await getPool()
      .query(`SELECT name,status,next_run_at,last_started_at,last_finished_at,last_success_at,last_file,last_bytes,last_error,
    failure_count,last_rehearsal_at,last_rehearsal_error FROM maintenance_jobs ORDER BY name`)
  ).rows;
}

async function archiveParts(file: string, key: Buffer) {
  const size = (await stat(file)).size;
  if (size < HEADER_BYTES + TAG_BYTES + 4)
    throw new MaintenanceError("BACKUP_ARCHIVE_INVALID");
  const handle = await open(file, "r");
  const header = Buffer.alloc(HEADER_BYTES),
    tag = Buffer.alloc(TAG_BYTES);
  try {
    await handle.read(header, 0, HEADER_BYTES, 0);
    await handle.read(tag, 0, TAG_BYTES, size - TAG_BYTES);
  } finally {
    await handle.close();
  }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC))
    throw new MaintenanceError("BACKUP_ARCHIVE_INVALID");
  const decrypt = () => {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      header.subarray(MAGIC.length)
    );
    decipher.setAAD(header);
    decipher.setAuthTag(tag);
    return {
      source: createReadStream(file, {
        start: HEADER_BYTES,
        end: size - TAG_BYTES - 1,
      }),
      decipher,
    };
  };
  return { decrypt };
}

async function authenticateManifest(file: string, key: Buffer) {
  const parts = await archiveParts(file, key);
  let prefix = Buffer.alloc(0),
    length: number | undefined;
  const collector = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      try {
        if (length === undefined || prefix.length < length + 4) {
          const limit =
            length === undefined ? MAX_MANIFEST_BYTES + 4 : length + 4;
          prefix = Buffer.concat([
            prefix,
            chunk.subarray(0, Math.max(0, limit - prefix.length)),
          ]);
          if (length === undefined && prefix.length >= 4) {
            length = prefix.readUInt32BE();
            if (length < 2 || length > MAX_MANIFEST_BYTES)
              throw new MaintenanceError("BACKUP_MANIFEST_INVALID");
            prefix = prefix.subarray(0, length + 4);
          }
        }
        callback();
      } catch {
        callback(new MaintenanceError("BACKUP_MANIFEST_INVALID"));
      }
    },
  });
  const { source, decipher } = parts.decrypt();
  try {
    await pipeline(source, decipher, collector);
  } catch {
    throw new MaintenanceError("BACKUP_AUTHENTICATION_FAILED");
  }
  if (length === undefined || prefix.length !== length + 4)
    throw new MaintenanceError("BACKUP_MANIFEST_INVALID");
  let manifest: Manifest;
  try {
    manifest = JSON.parse(prefix.subarray(4).toString("utf8"));
  } catch {
    throw new MaintenanceError("BACKUP_MANIFEST_INVALID");
  }
  if (
    manifest.format !== 1 ||
    !Array.isArray(manifest.tableCounts) ||
    !Array.isArray(manifest.migrations) ||
    !manifest.tableCounts.length ||
    manifest.tableCounts.some(
      value => typeof value.table !== "string" || !/^\d+$/.test(value.count)
    )
  )
    throw new MaintenanceError("BACKUP_MANIFEST_INVALID");
  return { manifest, prefixBytes: length + 4, parts };
}

async function performRestoreRehearsal(
  options: BackupOptions & { backupFile?: string } = {}
) {
  const key = backupKey(),
    directory = await privateDirectory();
  const files = (await readdir(directory))
    .filter(name => ARCHIVE_NAME.test(name))
    .sort();
  const selected = options.backupFile ?? files.at(-1);
  if (
    !selected ||
    basename(selected) !== selected ||
    !ARCHIVE_NAME.test(selected)
  )
    throw new MaintenanceError("BACKUP_FILE_NOT_FOUND");
  const file = await realpath(join(directory, selected));
  if (!inside(directory, file))
    throw new MaintenanceError("BACKUP_PATH_OUTSIDE_RUNTIME");
  // Authenticate the complete archive BEFORE creating a database or executing restored SQL.
  const authenticated = await authenticateManifest(file, key);
  const identity = databaseIdentity();
  if (authenticated.manifest.database !== identity.database)
    throw new MaintenanceError("BACKUP_DATABASE_SCOPE_MISMATCH");
  const temporaryDatabase = `tg_sender_rehearsal_${randomBytes(12).toString("hex")}`;
  if (
    !REHEARSAL_NAME.test(temporaryDatabase) ||
    temporaryDatabase === identity.database
  )
    throw new MaintenanceError("RESTORE_TARGET_UNSAFE");
  const adminUrl = new URL(identity.url);
  adminUrl.pathname = "/postgres";
  const admin = new Pool(
    databasePoolConfig({ ...process.env, DATABASE_URL: adminUrl.toString() })
  );
  admin.on("error", () => {});
  let restoredPool: Pool | undefined,
    created = false,
    verified = false;
  const pg = await postgresEnvironment(directory, temporaryDatabase);
  try {
    const exists = await admin.query(
      "SELECT 1 FROM pg_database WHERE datname=$1",
      [temporaryDatabase]
    );
    if (exists.rowCount) throw new MaintenanceError("RESTORE_TARGET_EXISTS");
    await admin.query(
      `CREATE DATABASE ${quoteIdentifier(temporaryDatabase)} TEMPLATE template0`
    );
    created = true;
    const restore = command(
      postgresBinary("pg_restore"),
      [
        "--no-owner",
        "--no-privileges",
        "--exit-on-error",
        "--dbname",
        temporaryDatabase,
      ],
      pg.env,
      options.signal
    );
    restore.process.stdout.resume();
    let remaining = authenticated.prefixBytes;
    const skipManifest = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        const skip = Math.min(remaining, chunk.length);
        remaining -= skip;
        callback(null, chunk.subarray(skip));
      },
    });
    const { source, decipher } = authenticated.parts.decrypt();
    try {
      await Promise.all([
        pipeline(source, decipher, skipManifest, restore.process.stdin),
        restore.done,
      ]);
    } catch (error) {
      restore.process.kill();
      await restore.done.catch(() => {});
      throw error;
    }
    const restoreUrl = new URL(identity.url);
    restoreUrl.pathname = `/${temporaryDatabase}`;
    restoredPool = new Pool(
      databasePoolConfig({
        ...process.env,
        DATABASE_URL: restoreUrl.toString(),
      })
    );
    restoredPool.on("error", () => {});
    for (const table of authenticated.manifest.tableCounts) {
      const actual = await restoredPool.query(
        `SELECT count(*)::text AS count FROM public.${quoteIdentifier(table.table)}`
      );
      if (actual.rows[0].count !== table.count)
        throw new MaintenanceError("RESTORE_ROW_COUNT_MISMATCH");
    }
    const migrations = await restoredPool.query(
      "SELECT name,checksum FROM app_migrations ORDER BY name"
    );
    if (
      JSON.stringify(migrations.rows) !==
      JSON.stringify(authenticated.manifest.migrations)
    )
      throw new MaintenanceError("RESTORE_MIGRATION_MISMATCH");
    verified = true;
    return {
      verified: true,
      backupFile: selected,
      tablesVerified: authenticated.manifest.tableCounts.length,
      migrationsVerified: migrations.rowCount,
      temporaryDatabaseRemoved: true,
    };
  } catch (error) {
    const code = safeError(error);
    await getPool()
      .query(
        "UPDATE maintenance_jobs SET last_rehearsal_error=$1 WHERE name='daily_backup'",
        [code]
      )
      .catch(() => {});
    throw new MaintenanceError(code);
  } finally {
    key.fill(0);
    await pg.cleanup();
    await restoredPool?.end();
    try {
      if (created) {
        // Cleanup is limited to the exact random database created by this invocation.
        if (
          !REHEARSAL_NAME.test(temporaryDatabase) ||
          temporaryDatabase === identity.database
        )
          throw new MaintenanceError("RESTORE_CLEANUP_TARGET_UNSAFE");
        await admin.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()",
          [temporaryDatabase]
        );
        await admin.query(
          `DROP DATABASE ${quoteIdentifier(temporaryDatabase)}`
        );
      }
      if (verified)
        await getPool().query(
          "UPDATE maintenance_jobs SET last_rehearsal_at=now(),last_rehearsal_error=NULL WHERE name='daily_backup'"
        );
    } catch {
      await getPool()
        .query(
          "UPDATE maintenance_jobs SET last_rehearsal_error='RESTORE_CLEANUP_FAILED' WHERE name='daily_backup'"
        )
        .catch(() => {});
      throw new MaintenanceError("RESTORE_CLEANUP_FAILED");
    } finally {
      await admin.end();
    }
  }
}

export async function rehearseLatestBackup(
  options: BackupOptions & { backupFile?: string } = {}
) {
  try {
    return await performRestoreRehearsal({
      ...options,
      signal: boundedSignal(options.signal),
    });
  } catch (error) {
    const code = safeError(error);
    await getPool()
      .query(
        "UPDATE maintenance_jobs SET last_rehearsal_error=$1 WHERE name='daily_backup'"
      )
      .catch(() => {});
    throw new MaintenanceError(code);
  }
}
