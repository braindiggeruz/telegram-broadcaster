import express from "express";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { readiness } from "../operations";
import { registerAutomationWebhook } from "../automation";
import { registerTelegramWebhook } from "../telegramWebhook";
import { registerAudienceSourceWebhook } from "../audienceSource";
import { registerMediaRoutes } from "../media";

export const securityHeaders = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
} as const;

// API construction is shared by the local Node server and Workers. Filesystem,
// Vite, port binding and startup checks belong to the environment's entrypoint.
export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    for (const [name, value] of Object.entries(securityHeaders)) {
      if (
        name !== "Content-Security-Policy" ||
        process.env.NODE_ENV === "production"
      )
        res.setHeader(name, value);
    }
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
  registerMediaRoutes(app);
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
  return app;
}
