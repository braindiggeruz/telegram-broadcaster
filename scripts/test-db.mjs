import "dotenv/config";
import { spawnSync } from "node:child_process";
const result = spawnSync(
  process.execPath,
  ["node_modules/vitest/vitest.mjs", "run"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      TEST_DATABASE_URL:
        process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL,
      LIVE_SEND_ENABLED: "false",
    },
    windowsHide: true,
  }
);
process.exitCode = result.status ?? 1;
