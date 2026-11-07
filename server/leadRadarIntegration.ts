import { createHash, timingSafeEqual } from "node:crypto";
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { getPool } from "./connection";
import { getMtprotoSession } from "./db";
import {
  telegramTransport,
  resolveLeadRadarUsername,
  verifyLeadRadarSession,
} from "./telegramTransport";
import {
  LR_SCHEMA,
  LR_PREFIX,
  LeadRadarEffects,
  LrIntegrationError,
  integrationConfig,
  lrEffectKeySchema,
  lrBindingSchema,
  type LrConfig,
} from "./delivery/leadRadarEffects";

function validToken(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith("Bearer ") || header.length > 150) return false;
  return timingSafeEqual(
    createHash("sha256").update(header.slice(7)).digest(),
    createHash("sha256").update(expected).digest()
  );
}

export function registerLeadRadarIntegration(
  app: Express,
  options: {
    config?: () => LrConfig | null;
    effects?: () => LeadRadarEffects;
  } = {}
) {
  const effects =
    options.effects ??
    (() =>
      new LeadRadarEffects(
        getPool(),
        telegramTransport,
        async ownerId => {
          const session = await getMtprotoSession(ownerId);
          return session?.isActive && session.sessionString
            ? createHash("sha256").update(session.sessionString).digest("hex")
            : null;
        },
        () => process.env.LIVE_SEND_ENABLED === "true",
        resolveLeadRadarUsername,
        async ownerId => {
          const session = await getMtprotoSession(ownerId);
          const suffix = String(session?.phone ?? "")
            .replace(/\D/g, "")
            .slice(-4);
          return suffix ? `Telegram •••• ${suffix}` : "TG Sender";
        },
        verifyLeadRadarSession
      ));
  const route =
    (
      action: (
        req: Request,
        res: Response,
        config: LrConfig,
        service: LeadRadarEffects
      ) => Promise<void>
    ) =>
    (req: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-store");
      const config = (options.config ?? integrationConfig)();
      if (!config) {
        res
          .status(503)
          .json({ schema: LR_SCHEMA, error: "INTEGRATION_DISABLED" });
        return;
      }
      // Runtime token is server-to-server only; never use the owner's web password/session.
      if (
        req.headers.origin ||
        !validToken(req.get("Authorization"), config.token)
      ) {
        res.status(401).json({ schema: LR_SCHEMA, error: "UNAUTHORIZED" });
        return;
      }
      void Promise.resolve()
        .then(() => action(req, res, config, effects()))
        .catch(error => {
          const code =
            error instanceof LrIntegrationError
              ? error.code
              : "INTEGRATION_UNAVAILABLE";
          res
            .status(
              code === "SCOPE_MISMATCH"
                ? 403
                : code === "PAYLOAD_CONFLICT"
                  ? 409
                  : code === "INVALID_PAYLOAD"
                    ? 400
                    : 503
            )
            .json({ schema: LR_SCHEMA, error: code });
        });
    };
  app.get(
    `${LR_PREFIX}/status`,
    route(async (_req, res, config, service) => {
      res.json(await service.status(config));
    })
  );
  app.post(
    `${LR_PREFIX}/session/probe`,
    route(async (req, res, config, service) => {
      const parsed = z
        .object({ schema: z.literal(LR_SCHEMA), binding: lrBindingSchema })
        .strict()
        .safeParse(req.body);
      if (!parsed.success) throw new LrIntegrationError("INVALID_PAYLOAD");
      res.json(await service.probe(config, parsed.data.binding));
    })
  );
  app.post(
    `${LR_PREFIX}/contacts/resolve`,
    route(async (req, res, config, service) => {
      const parsed = z
        .object({
          schema: z.literal(LR_SCHEMA),
          binding: lrBindingSchema,
          username: z.string().regex(/^[a-z][a-z0-9_]{4,31}$/),
        })
        .strict()
        .safeParse(req.body);
      if (!parsed.success) throw new LrIntegrationError("INVALID_PAYLOAD");
      res.json(
        await service.resolve(config, parsed.data.binding, parsed.data.username)
      );
    })
  );
  app.post(
    `${LR_PREFIX}/effects`,
    route(async (req, res, config, service) => {
      if (
        !req.body?.effect_id ||
        req.get("Idempotency-Key") !== req.body.effect_id
      )
        throw new LrIntegrationError("INVALID_PAYLOAD");
      res.json(await service.dispatch(config, req.body));
    })
  );
  app.get(
    `${LR_PREFIX}/effects/:effectId`,
    route(async (req, res, config, service) => {
      const parsed = lrEffectKeySchema.safeParse({
        schema: LR_SCHEMA,
        binding: config.binding,
        effect_id: req.params.effectId,
        payload_sha256: req.get("X-Payload-SHA256"),
      });
      if (!parsed.success) throw new LrIntegrationError("INVALID_PAYLOAD");
      res.json(await service.read(config, parsed.data));
    })
  );
  app.post(
    `${LR_PREFIX}/effects/:effectId/cancel`,
    route(async (req, res, config, service) => {
      const parsed = lrEffectKeySchema.safeParse(req.body);
      if (!parsed.success || parsed.data.effect_id !== req.params.effectId)
        throw new LrIntegrationError("INVALID_PAYLOAD");
      res.json(await service.cancel(config, parsed.data));
    })
  );
}
