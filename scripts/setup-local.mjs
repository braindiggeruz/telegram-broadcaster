import { randomBytes, scryptSync } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
const root = resolve(import.meta.dirname, "..");
const runtime = resolve(root, ".runtime");
mkdirSync(runtime, { recursive: true });
const envFile = resolve(root, ".env");
if (existsSync(envFile)) {
  console.log("Configuration exists; preserving .env.");
} else {
  const password = randomBytes(24).toString("base64url");
  const salt = randomBytes(16).toString("base64url");
  const hash = scryptSync(password, Buffer.from(salt, "base64url"), 64, {
    N: 16384,
    r: 8,
    p: 1,
  }).toString("base64url");
  const dbPassword = randomBytes(24).toString("base64url");
  writeFileSync(resolve(runtime, "owner-password.txt"), password + "\n", {
    mode: 0o600,
  });
  writeFileSync(resolve(runtime, "postgres-password.txt"), dbPassword + "\n", {
    mode: 0o600,
  });
  writeFileSync(
    envFile,
    [
      "NODE_ENV=development",
      "HOST=127.0.0.1",
      "PORT=3037",
      "APP_ORIGIN=http://127.0.0.1:3037",
      `DATABASE_URL=postgresql://tgsender:${dbPassword}@127.0.0.1:54329/tgsender`,
      "DATABASE_SSL=disable",
      "OWNER_OPEN_ID=local-owner",
      `OWNER_PASSWORD_HASH='scrypt$16384$8$1$${salt}$${hash}'`,
      `SESSION_SECRET=${randomBytes(48).toString("base64url")}`,
      `ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`,
      `BACKUP_KEY_BASE64=${randomBytes(32).toString("base64")}`,
      `TELEGRAM_WEBHOOK_SECRET=${randomBytes(32).toString("hex")}`,
      "LIVE_SEND_ENABLED=false",
      "CONTACT_MIN_INTERVAL_SECONDS=86400",
      "TELEGRAM_API_ID=",
      "TELEGRAM_API_HASH=",
      "",
    ].join("\n"),
    { mode: 0o600 }
  );
  console.log(
    "Created local configuration. Owner password saved privately in .runtime/owner-password.txt."
  );
}
if (process.platform === "win32") {
  const identity = spawnSync("whoami", [], { encoding: "utf8" }).stdout.trim();
  for (const file of [envFile, runtime]) {
    const r = spawnSync(
      "icacls",
      [
        file,
        "/inheritance:r",
        "/grant:r",
        `${identity}:${file === runtime ? "(OI)(CI)" : ""}F`,
      ],
      { encoding: "utf8" }
    );
    if (r.status !== 0)
      throw new Error("Could not restrict local secret permissions");
  }
}
