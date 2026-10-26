import "dotenv/config";
import { createServer } from "node:http";
import { createApp } from "./app";
import { serveStatic, setupVite } from "./vite";
import { assertSecurityConfiguration } from "../security/config";
import { getPool, closePool } from "../connection";

async function startServer() {
  assertSecurityConfiguration();
  await getPool().query("SELECT 1 FROM app_migrations LIMIT 1");
  const app = createApp(),
    server = createServer(app);
  if (process.env.NODE_ENV === "development") await setupVite(app, server);
  else serveStatic(app);
  const port = Number(process.env.PORT ?? 3037),
    host = process.env.HOST ?? "127.0.0.1";
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("INVALID_PORT");
  server.listen(port, host, () =>
    console.log(
      `TG Sender ready at ${process.env.APP_ORIGIN}; live sends ${process.env.LIVE_SEND_ENABLED === "true" ? "enabled" : "disabled"}`
    )
  );
  const stop = () =>
    server.close(() => {
      void closePool().finally(() => process.exit(0));
    });
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
void startServer().catch(() => {
  console.error("STARTUP_FAILED: check configuration and migrations.");
  process.exitCode = 1;
});
