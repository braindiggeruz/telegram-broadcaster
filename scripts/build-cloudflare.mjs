import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

const root = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const wrangler = resolve(
  dirname(require.resolve("wrangler/package.json")),
  "bin/wrangler.js"
);
const outdir = resolve(root, "dist/cloudflare");
mkdirSync(outdir, { recursive: true });
// Explicit empty env file prevents local .env values entering CLI diagnostics.
const emptyEnv = resolve(outdir, "build.env");
writeFileSync(emptyEnv, "# No runtime secrets are used during the build.\n", {
  mode: 0o600,
});
const result = spawnSync(
  process.execPath,
  [
    wrangler,
    "deploy",
    "--dry-run",
    "--config",
    resolve(root, "cloudflare/wrangler.jsonc"),
    "--env-file",
    emptyEnv,
    "--outdir",
    outdir,
  ],
  {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
    env: {
      ...process.env,
      WRANGLER_BUILD_PLATFORM: "node",
      WRANGLER_SEND_METRICS: "false",
      CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
    },
  }
);
if (result.error) {
  console.error("CLOUDFLARE_BUILD_FAILED: unable to start Wrangler.");
  process.exitCode = 1;
} else process.exitCode = result.status ?? 1;
