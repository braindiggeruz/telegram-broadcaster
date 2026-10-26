import { spawn } from "node:child_process";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";

// Linux CI only. Never reads .env, uses real Telegram credentials or deploys.
const root = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const cancellation = new AbortController();
const children = [];
let admin;
let directory;
let database;
let databaseCreated = false;
let stage = "preflight";
let checked = 0;

class SmokeError extends Error {}

function check(name, passed, counts) {
  if (!passed) {
    if (counts) console.error(JSON.stringify({ check: name, counts }));
    throw new SmokeError(name);
  }
  checked++;
  console.log(JSON.stringify({ check: name, pass: true }));
}

function progressCounts(progress) {
  // Only allow numeric counters into diagnostics, never recipients or messages.
  return Object.fromEntries(
    ["dryRun", "pending", "accepted", "failed", "unknown", "suppressed"].map(
      name => [name, Number.isFinite(progress[name]) ? progress[name] : null]
    )
  );
}

function launch(args, env) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Wrangler diagnostics can contain bindings. Consume them without printing.
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  const tracked = { child, closed: false, code: null };
  tracked.done = new Promise(resolveDone => {
    child.once("error", () => {
      tracked.closed = true;
      resolveDone(-1);
    });
    child.once("close", code => {
      tracked.closed = true;
      tracked.code = code;
      resolveDone(code);
    });
  });
  children.push(tracked);
  return tracked;
}

async function stop(tracked) {
  if (!tracked.child.pid || tracked.closed) return;
  // Each child owns a new Linux process group, including Wrangler's workerd.
  try {
    process.kill(-tracked.child.pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") throw new SmokeError("child_cleanup_failed");
    return;
  }
  const exited = await Promise.race([
    tracked.done.then(() => true),
    delay(5000, false, { ref: false }),
  ]);
  if (!exited) {
    try {
      process.kill(-tracked.child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw new SmokeError("child_cleanup_failed");
    }
    await Promise.race([tracked.done, delay(5000, undefined, { ref: false })]);
  }
}

async function freePort() {
  const socket = createServer();
  await new Promise((resolveReady, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolveReady);
  });
  const port = socket.address().port;
  await new Promise((resolveClosed, reject) =>
    socket.close(error => (error ? reject(error) : resolveClosed()))
  );
  return port;
}

function signal(milliseconds = 30_000) {
  return AbortSignal.any([
    cancellation.signal,
    AbortSignal.timeout(milliseconds),
  ]);
}

async function run() {
  if (process.platform !== "linux")
    throw new SmokeError("linux_runner_required");
  const source = new URL(process.env.TEST_DATABASE_URL ?? "");
  if (
    !["postgres:", "postgresql:"].includes(source.protocol) ||
    !["127.0.0.1", "[::1]"].includes(source.hostname) ||
    source.search ||
    source.hash
  )
    throw new SmokeError("literal_loopback_test_database_required");
  admin = new pg.Pool({
    connectionString: source.toString(),
    ssl: false,
    max: 1,
    connectionTimeoutMillis: 5000,
    query_timeout: 15_000,
    application_name: "tg-sender-cloudflare-ci-admin",
  });
  admin.on("error", () => cancellation.abort());
  database = `tg_sender_cf_ci_${randomBytes(12).toString("hex")}`;
  stage = "create_isolated_database";
  await admin.query(`CREATE DATABASE "${database}"`);
  databaseCreated = true;
  source.pathname = `/${database}`;

  await mkdir(resolve(root, ".runtime"), { recursive: true, mode: 0o700 });
  directory = await mkdtemp(resolve(root, ".runtime/cloudflare-ci-"));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const password = randomBytes(32).toString("base64url");
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 64, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  const runtime = {
    NODE_ENV: "production",
    WORKER_MODE: "scheduled",
    APP_ORIGIN: base,
    DATABASE_URL: source.toString(),
    DATABASE_SSL: "disable",
    OWNER_OPEN_ID: "cloudflare-ci-owner",
    OWNER_PASSWORD_HASH: `scrypt$16384$8$1$${salt.toString("base64url")}$${key.toString("base64url")}`,
    SESSION_SECRET: randomBytes(48).toString("base64url"),
    ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    BACKUP_KEY_BASE64: randomBytes(32).toString("base64"),
    TELEGRAM_WEBHOOK_SECRET: randomBytes(32).toString("hex"),
    TELEGRAM_API_ID: "",
    TELEGRAM_API_HASH: "",
    LIVE_SEND_ENABLED: "false",
  };
  await writeFile(
    resolve(directory, ".dev.vars"),
    Object.entries(runtime)
      .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
      .join("\n") + "\n",
    { mode: 0o600, flag: "wx" }
  );
  const emptyEnv = resolve(directory, "empty.env");
  await writeFile(emptyEnv, "# Synthetic configuration only.\n", {
    mode: 0o600,
    flag: "wx",
  });
  // Pass only OS paths and synthetic values; never inherit provider credentials.
  const env = Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"].flatMap(name =>
      process.env[name] ? [[name, process.env[name]]] : []
    )
  );
  Object.assign(env, runtime, {
    DOTENV_CONFIG_PATH: emptyEnv,
    WRANGLER_BUILD_PLATFORM: "node",
    WRANGLER_SEND_METRICS: "false",
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
    CI: "true",
    BROWSER: "none",
    NO_COLOR: "1",
  });
  stage = "migrate_isolated_database";
  const migration = launch(
    [
      resolve(dirname(require.resolve("tsx/package.json")), "dist/cli.mjs"),
      "scripts/migrate.ts",
    ],
    env
  );
  const migrated = await Promise.race([
    migration.done,
    delay(60_000, -1, { signal: cancellation.signal, ref: false }),
  ]);
  check("isolated_database_migrated", migrated === 0);

  const ts = require("typescript");
  const configFile = resolve(root, "cloudflare/wrangler.jsonc");
  const parsed = ts.parseConfigFileTextToJson(
    configFile,
    await readFile(configFile, "utf8")
  );
  if (parsed.error) throw new SmokeError("worker_configuration_invalid");
  const config = {
    ...parsed.config,
    name: "tg-sender-ci",
    main: resolve(root, "cloudflare/index.ts"),
    assets: {
      ...parsed.config.assets,
      directory: resolve(root, "dist/public"),
      // Wrangler's local scheduled middleware runs inside the user Worker.
      // Otherwise the production assets-first router serves SPA HTML here.
      // Add the test route only to this temporary config, never to production.
      run_worker_first:
        parsed.config.assets?.run_worker_first === true
          ? true
          : [
              ...new Set([
                ...(Array.isArray(parsed.config.assets?.run_worker_first)
                  ? parsed.config.assets.run_worker_first
                  : []),
                "/__scheduled",
              ]),
            ],
    },
    vars: {
      ...parsed.config.vars,
      APP_ORIGIN: base,
      DATABASE_SSL: "disable",
      DATABASE_TRANSPORT: "tcp",
      DATABASE_RELAY_URL: "",
      WORKER_MODE: "scheduled",
      LIVE_SEND_ENABLED: "false",
    },
  };
  delete config.$schema;
  const localConfig = resolve(directory, "wrangler.json");
  await writeFile(localConfig, JSON.stringify(config), {
    mode: 0o600,
    flag: "wx",
  });
  stage = "start_native_workerd";
  const worker = launch(
    [
      resolve(
        dirname(require.resolve("wrangler/package.json")),
        "bin/wrangler.js"
      ),
      "dev",
      "--local",
      "--config",
      localConfig,
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--inspector-port",
      "0",
      "--test-scheduled",
    ],
    env
  );
  // Wrangler dev loads .dev.vars beside the config; --env-file would bypass it.
  const startupDeadline = Date.now() + 120_000;
  let alive = false;
  while (!alive && Date.now() < startupDeadline && !worker.closed) {
    try {
      const health = await fetch(`${base}/healthz`, { signal: signal(2500) });
      alive = health.ok && (await health.json()).alive === true;
    } catch {
      cancellation.signal.throwIfAborted();
    }
    if (!alive) await delay(1000, undefined, { signal: cancellation.signal });
  }
  check("native_workerd_health", alive);
  stage = "http_and_cron";

  const html = await fetch(base, { signal: signal() });
  check(
    "static_assets_csp",
    html.ok &&
      html.headers.get("content-type")?.includes("text/html") &&
      html.headers
        .get("content-security-policy")
        ?.includes("frame-ancestors 'none'") &&
      html.headers.get("x-content-type-options") === "nosniff" &&
      (await html.text()).includes('<div id="root">')
  );

  let cookie;
  async function rpc(name, input, post = false) {
    const query =
      !post && input
        ? `?input=${encodeURIComponent(JSON.stringify({ json: input }))}`
        : "";
    const response = await fetch(`${base}/api/trpc/${name}${query}`, {
      method: post ? "POST" : "GET",
      headers: {
        Origin: base,
        ...(post ? { "Content-Type": "application/json" } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(post ? { body: JSON.stringify({ json: input }) } : {}),
      signal: signal(),
    });
    const payload = await response.json();
    if (!response.ok || payload.error)
      throw new SmokeError(`rpc_${name}_failed`);
    if (name === "auth.login") {
      const sessionCookie = response.headers
        .getSetCookie()
        .find(value => value.startsWith("app_session_id="));
      check(
        "session_cookie_http_only",
        !!sessionCookie &&
          /HttpOnly/i.test(sessionCookie) &&
          /SameSite=Strict/i.test(sessionCookie)
      );
      cookie = sessionCookie.split(";")[0];
    }
    return payload.result.data.json;
  }
  check("anonymous_auth_me", (await rpc("auth.me")) === null);
  const anonymousAuthStatus = await fetch(
    `${base}/api/trpc/mtproto.getAuthStatus`,
    { signal: signal() }
  );
  await anonymousAuthStatus.arrayBuffer();
  check("anonymous_auth_status_denied", anonymousAuthStatus.status === 401);
  check(
    "owner_login",
    (await rpc("auth.login", { password }, true)).success === true
  );
  const authStatus = await rpc("mtproto.getAuthStatus");
  check(
    "auth_status_is_private_and_readable",
    authStatus.pending === null &&
      authStatus.retryAt === null &&
      authStatus.attemptsRemaining === 3 &&
      Math.abs(Date.parse(authStatus.serverNow) - Date.now()) < 30_000 &&
      !/phoneCodeHash|sessionString|payload_encrypted/.test(
        JSON.stringify(authStatus)
      )
  );
  const parallel = await Promise.all(
    Array.from({ length: 5 }, () => rpc("auth.me"))
  );
  check(
    "parallel_request_database_scopes",
    parallel.every(user => user.role === "admin")
  );
  const foreignOrigin = await fetch(`${base}/api/trpc/auth.logout`, {
    method: "POST",
    headers: {
      Origin: "https://wrong.invalid",
      "Content-Type": "application/json",
      Cookie: cookie,
    },
    body: JSON.stringify({ json: null }),
    signal: signal(),
  });
  await foreignOrigin.arrayBuffer();
  check("foreign_origin_rejected", foreignOrigin.status === 403);

  const list = await rpc(
    "recipients.upload",
    {
      name: `Cloudflare CI ${randomUUID()}`,
      content: JSON.stringify(["123456701", "123456702"]),
      fileType: "json",
      recipientType: "chat_id",
      consentSource: "Synthetic CI fixture",
      consentConfirmed: true,
      permissionTransport: "bot",
    },
    true
  );
  const botAudience = await rpc("recipients.audienceStatus", {
    id: list.id,
    transport: "bot",
  });
  const accountAudience = await rpc("recipients.audienceStatus", {
    id: list.id,
    transport: "mtproto",
  });
  check(
    "audience_preflight_has_sender_scoped_permissions",
    botAudience.total === 2 &&
      botAudience.allowed === 2 &&
      accountAudience.total === 2 &&
      accountAudience.allowed === 0 &&
      accountAudience.needsConfirmation === 2 &&
      !/recipient|chatIds|phone/.test(JSON.stringify(botAudience))
  );
  const campaign = await rpc(
    "broadcast.create",
    {
      name: `Cloudflare CI ${randomUUID()}`,
      message: "Synthetic dry run",
      parseMode: "None",
      delaySeconds: 1,
      isDryRun: true,
      recipientListId: list.id,
      requestKey: randomUUID(),
      approved: true,
    },
    true
  );
  check(
    "dry_campaign_launched",
    (await rpc("broadcast.launch", { id: campaign.id }, true)).started === true
  );
  async function cron() {
    const response = await fetch(
      `${base}/__scheduled?cron=${encodeURIComponent("* * * * *")}`,
      { signal: signal(65_000) }
    );
    const acknowledged =
      (await response.text()).trim() === "Ran scheduled event";
    if (!response.ok || !acknowledged) {
      console.error(
        JSON.stringify({
          check: "cron_dispatch",
          status: response.status,
          scheduledAcknowledged: acknowledged,
        })
      );
      throw new SmokeError("cron_invocation_failed");
    }
  }
  await cron();
  const first = await rpc("broadcast.getProgress", { id: campaign.id });
  check(
    "cron_processed_two_dry_runs",
    first.dryRun === 2 && first.pending === 0 && first.accepted === 0,
    progressCounts(first)
  );
  await Promise.all([cron(), cron()]);
  const final = await rpc("broadcast.getProgress", { id: campaign.id });
  const logs = await rpc("broadcast.getLogs", { id: campaign.id });
  check(
    "concurrent_cron_has_no_duplicates",
    final.dryRun === 2 && final.accepted === 0 && logs.length === 2,
    { ...progressCounts(final), logs: logs.length }
  );
  const cancelledCampaign = await rpc(
    "broadcast.create",
    {
      name: `Cloudflare stop CI ${randomUUID()}`,
      message: "Synthetic cancellation check",
      parseMode: "None",
      delaySeconds: 1,
      isDryRun: true,
      recipientListId: list.id,
      requestKey: randomUUID(),
      approved: true,
    },
    true
  );
  await rpc("broadcast.launch", { id: cancelledCampaign.id }, true);
  const stopped = await rpc(
    "broadcast.cancel",
    { id: cancelledCampaign.id },
    true
  );
  const stoppedProgress = await rpc("broadcast.getProgress", {
    id: cancelledCampaign.id,
  });
  check(
    "stop_acknowledged_and_verified_by_progress",
    stopped.acknowledged === true &&
      stopped.status === "stopped" &&
      stoppedProgress.status === "stopped" &&
      stoppedProgress.cancelled === 2 &&
      stoppedProgress.pending === 0 &&
      stoppedProgress.inflight === 0 &&
      stoppedProgress.accepted === 0
  );
  const stoppedAgain = await rpc(
    "broadcast.cancel",
    { id: cancelledCampaign.id },
    true
  );
  check(
    "repeated_stop_is_idempotent",
    stoppedAgain.acknowledged === true && stoppedAgain.status === "stopped"
  );
  const ready = await fetch(`${base}/readyz`, { signal: signal() });
  check(
    "database_and_cron_ready",
    ready.ok && (await ready.json()).ready === true
  );
  const operations = await rpc("operations.status");
  check("live_sends_remain_disabled", operations.liveSendEnabled === false);

  // Exercise the real Workers binary response/crypto/PG path, not just Node mocks.
  const photoBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1kAAAAASUVORK5CYII=",
    "base64"
  );
  const photo = await rpc(
    "media.uploadPhoto",
    {
      name: "ci-photo.png",
      mimeType: "image/png",
      dataBase64: photoBytes.toString("base64"),
    },
    true
  );
  check(
    "photo_upload_metadata_only",
    photo.size === photoBytes.length &&
      photo.url === `/api/media/${photo.id}` &&
      !photo.dataBase64 &&
      !photo.content_encrypted
  );
  const image = await fetch(base + photo.url, {
    headers: { Cookie: cookie },
    signal: signal(),
  });
  check(
    "private_photo_binary_response",
    image.ok &&
      image.headers.get("content-type") === "image/png" &&
      Buffer.from(await image.arrayBuffer()).equals(photoBytes)
  );
  const deniedImage = await fetch(base + photo.url, { signal: signal() });
  check("anonymous_photo_denied", deniedImage.status === 401);
  await rpc(
    "draft.save",
    {
      key: "mtproto",
      message: "",
      parseMode: "None",
      photoId: photo.id,
      expectedVersion: 0,
    },
    true
  );
  const photoDraft = await rpc("draft.get", { key: "mtproto" });
  check(
    "photo_draft_persisted",
    photoDraft.photoId === photo.id && photoDraft.photo?.sha256 === photo.sha256
  );
  const photoList = await rpc(
    "recipients.upload",
    {
      name: "Photo CI",
      content: JSON.stringify(["123456703"]),
      fileType: "json",
      recipientType: "chat_id",
      consentSource: "Synthetic photo CI",
      consentConfirmed: true,
      permissionTransport: "mtproto",
    },
    true
  );
  const photoCampaign = await rpc(
    "mtproto.createBroadcast",
    {
      name: "Photo-only CI",
      message: "",
      parseMode: "None",
      delaySeconds: 3,
      isDryRun: true,
      recipientListId: photoList.id,
      requestKey: randomUUID(),
      approved: true,
      photoId: photo.id,
    },
    true
  );
  await rpc("mtproto.launchBroadcast", { id: photoCampaign.id }, true);
  await cron();
  const photoProgress = await rpc("mtproto.getProgress", {
    id: photoCampaign.id,
  });
  check(
    "photo_only_cron_dry_run",
    photoProgress.dryRun === 1 &&
      photoProgress.pending === 0 &&
      photoProgress.accepted === 0
  );
}

for (const name of ["SIGINT", "SIGTERM"])
  process.once(name, () => cancellation.abort());

try {
  await run();
} catch (error) {
  console.error(
    JSON.stringify({
      pass: false,
      stage,
      error:
        error instanceof SmokeError ? error.message : "CLOUDFLARE_SMOKE_FAILED",
    })
  );
  process.exitCode = 1;
} finally {
  for (const child of children.reverse()) {
    try {
      await stop(child);
    } catch {
      console.error("CLOUDFLARE_SMOKE_PROCESS_CLEANUP_FAILED");
      process.exitCode = 1;
    }
  }
  if (databaseCreated && admin) {
    try {
      if (!/^tg_sender_cf_ci_[a-f0-9]{24}$/.test(database)) throw new Error();
      await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
    } catch {
      console.error("CLOUDFLARE_SMOKE_DATABASE_CLEANUP_FAILED");
      process.exitCode = 1;
    }
  }
  if (admin)
    await admin.end().catch(() => {
      process.exitCode = 1;
    });
  if (directory) {
    try {
      const actual = await realpath(directory);
      const runtimeRoot = await realpath(resolve(root, ".runtime"));
      if (
        !actual.startsWith(`${runtimeRoot}${sep}cloudflare-ci-`) ||
        dirname(actual) !== runtimeRoot
      )
        throw new Error();
      await rm(actual, { recursive: true });
    } catch {
      console.error("CLOUDFLARE_SMOKE_FILE_CLEANUP_FAILED");
      process.exitCode = 1;
    }
  }
}
if (!process.exitCode)
  console.log(JSON.stringify({ pass: true, checks: checked, cleaned: true }));
