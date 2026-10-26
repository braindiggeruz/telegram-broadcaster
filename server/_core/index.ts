import "dotenv/config";
import express from "express";
import { createServer } from "node:http";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { assertSecurityConfiguration } from "../security/config";
import { getPool, closePool } from "../connection";
import { readiness } from "../operations";
import { registerAutomationWebhook } from "../automation";
import { registerTelegramWebhook } from "../telegramWebhook";
import { registerAudienceSourceWebhook } from "../audienceSource";

async function startServer() {
  assertSecurityConfiguration();
  await getPool().query("SELECT 1 FROM app_migrations LIMIT 1");
  const app = express(),
    server = createServer(app);
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    if (process.env.NODE_ENV === "production")
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
      );
    next();
  });
  app.use(express.json({ limit: "3mb", inflate: false }));
  app.get("/healthz", (_req, res) => res.json({ alive: true }));
  app.get("/readyz", async (_req, res) => {
    const result = await readiness();
    res.status(result.ready ? 200 : 503).json({ ready: result.ready });
  });
  registerAutomationWebhook(app);
  registerTelegramWebhook(app);
  registerAudienceSourceWebhook(app);
  app.use(
    "/api/trpc",
    (_req, res, next) => {
      res.setHeader("Cache-Control", "no-store");
      next();
    },
    createExpressMiddleware({ router: appRouter, createContext })
  );
  app.use("/api", (_req, res) => res.status(404).json({ error: "NOT_FOUND" }));
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      const status = (error as { status?: number })?.status;
      res
        .status(status === 413 ? 413 : 400)
        .json({ error: status === 413 ? "BODY_TOO_LARGE" : "INVALID_REQUEST" });
    }
  );
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
