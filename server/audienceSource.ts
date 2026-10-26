import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Express } from "express";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { router, protectedProcedure } from "./_core/trpc";
import { getPool } from "./connection";
import { encryptSecret, decryptSecret } from "./security/secrets";
import { normalizeRecipient as normalizeInput } from "../shared/recipients";
import {
  normalizeRecipient as canonicalRecipient,
  type SenderKind,
} from "./delivery/types";

type Source = {
  id: number;
  owner_id: number;
  list_id: number;
  name: string;
  transport: SenderKind;
  request_key: string;
  request_hash: string;
  secret_hash: string;
  encrypted_secret: string;
  revoked_at: Date | null;
  created_at: Date;
  last_synced_at: Date | null;
};
const sourceInput = z
  .object({
    listId: z.number().int().positive(),
    transport: z.enum(["bot", "mtproto"]),
    name: z.string().trim().min(1).max(120),
    approved: z.literal(true),
    requestKey: z.string().min(1).max(128),
  })
  .strict();
const eventInput = z
  .object({
    eventId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9_.:-]+$/),
    recipients: z
      .array(
        z
          .object({
            value: z.string().min(1).max(128),
            subscribed: z.boolean(),
            consentAt: z.iso.datetime({ offset: true }).optional(),
          })
          .strict()
      )
      .min(1)
      .max(10000),
  })
  .strict();
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const secretContext = (ownerId: number, key: string) =>
  `audience-source:${ownerId}:${key}`;
const webhookPath = (id: number) => `/api/audience-sources/${id}/events`;

function dto(source: Source) {
  return {
    id: source.id,
    listId: source.list_id,
    name: source.name,
    transport: source.transport,
    active: !source.revoked_at,
    revokedAt: source.revoked_at,
    createdAt: source.created_at,
    lastSyncedAt: source.last_synced_at,
    webhookPath: webhookPath(source.id),
  };
}

function typedRecipient(value: string) {
  const raw = value.startsWith("chat:")
    ? value.slice(5)
    : value.startsWith("username:")
      ? `@${value.slice(9)}`
      : value.startsWith("phone:")
        ? value.slice(6)
        : value;
  const normalized = normalizeInput(raw, "auto");
  if (!normalized) throw new SourceError(400, "INVALID_RECIPIENT");
  return {
    value: normalized.value,
    type: normalized.type,
    recipient: canonicalRecipient(normalized.value),
  };
}

function listMembers(raw: string): Map<string, string> {
  let values: unknown;
  try {
    values = JSON.parse(raw);
  } catch {
    throw new SourceError(409, "LIST_REQUIRES_REVIEW");
  }
  if (!Array.isArray(values) || values.length > 50000)
    throw new SourceError(409, "LIST_REQUIRES_REVIEW");
  const members = new Map<string, string>();
  for (const value of values) {
    if (typeof value !== "string")
      throw new SourceError(409, "LIST_REQUIRES_REVIEW");
    const normalized = typedRecipient(value);
    members.set(normalized.recipient, normalized.value);
  }
  return members;
}

class SourceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code);
  }
}

export const audienceSourceRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const rows = await getPool().query<Source>(
      "SELECT * FROM audience_sources WHERE owner_id=$1 ORDER BY id DESC",
      [ctx.user.id]
    );
    return rows.rows.map(dto);
  }),
  create: protectedProcedure
    .input(sourceInput)
    .mutation(async ({ ctx, input }) => {
      const tx = await getPool().connect();
      try {
        await tx.query("BEGIN");
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `source:create:${ctx.user.id}:${input.requestKey}`,
        ]);
        const list = await tx.query<{ chatIds: string }>(
          'SELECT "chatIds" FROM recipient_lists WHERE id=$1 AND "userId"=$2 FOR SHARE',
          [input.listId, ctx.user.id]
        );
        if (!list.rowCount)
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Список не найден",
          });
        const hash = digest(
          JSON.stringify({
            listId: input.listId,
            transport: input.transport,
            name: input.name,
          })
        );
        const previous = await tx.query<Source>(
          "SELECT * FROM audience_sources WHERE owner_id=$1 AND request_key=$2",
          [ctx.user.id, input.requestKey]
        );
        if (previous.rowCount) {
          const source = previous.rows[0];
          if (source.request_hash !== hash || source.revoked_at)
            throw new TRPCError({
              code: "CONFLICT",
              message: "Ключ относится к другому или отключённому источнику",
            });
          const secret = decryptSecret(
            source.encrypted_secret,
            secretContext(ctx.user.id, input.requestKey)
          );
          await tx.query("COMMIT");
          return { ...dto(source), secret, webhookSecret: secret };
        }
        const members = listMembers(list.rows[0].chatIds);
        if (
          input.transport === "bot" &&
          [...members.keys()].some(value => value.startsWith("phone:"))
        )
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "Для бота выберите список chat ID или username; телефон не даёт боту доступ к личному чату.",
          });
        const secret = randomBytes(32).toString("base64url");
        const inserted = await tx.query<Source>(
          `INSERT INTO audience_sources(owner_id,list_id,name,transport,request_key,request_hash,secret_hash,encrypted_secret)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [
            ctx.user.id,
            input.listId,
            input.name,
            input.transport,
            input.requestKey,
            hash,
            digest(secret),
            encryptSecret(secret, secretContext(ctx.user.id, input.requestKey)),
          ]
        );
        const source = inserted.rows[0];
        await tx.query(
          "INSERT INTO audit_events(owner_id,action,target,detail) VALUES($1,'audience.source.approved',$2,$3)",
          [
            ctx.user.id,
            String(source.id),
            JSON.stringify({
              listId: input.listId,
              transport: input.transport,
              name: input.name,
            }),
          ]
        );
        await tx.query("COMMIT");
        return { ...dto(source), secret, webhookSecret: secret };
      } catch (error) {
        await tx.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        tx.release();
      }
    }),
  revoke: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }).strict())
    .mutation(async ({ ctx, input }) => {
      const tx = await getPool().connect();
      try {
        await tx.query("BEGIN");
        const row = await tx.query(
          "UPDATE audience_sources SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 AND owner_id=$2 RETURNING id",
          [input.id, ctx.user.id]
        );
        if (!row.rowCount)
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Источник не найден",
          });
        await tx.query(
          "INSERT INTO audit_events(owner_id,action,target) VALUES($1,'audience.source.revoked',$2)",
          [ctx.user.id, String(input.id)]
        );
        await tx.query("COMMIT");
        return { success: true as const };
      } catch (error) {
        await tx.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        tx.release();
      }
    }),
});

type SyncResult = {
  applied: true;
  duplicate: boolean;
  totalCount: number;
  subscribed: number;
  suppressed: number;
};

export async function applyAudienceSourceEvent(
  sourceId: number,
  secret: string,
  body: unknown
): Promise<SyncResult> {
  const parsed = eventInput.safeParse(body);
  if (!Number.isSafeInteger(sourceId) || sourceId <= 0 || !parsed.success)
    throw new SourceError(400, "INVALID_EVENT");
  if (!/^[A-Za-z0-9_-]{40,128}$/.test(secret))
    throw new SourceError(401, "UNAUTHORIZED");
  const tx = await getPool().connect();
  try {
    await tx.query("BEGIN");
    // Verify the capability before taking a source lock, then re-check revocation under the lock.
    const check = await tx.query<Source>(
      "SELECT * FROM audience_sources WHERE id=$1",
      [sourceId]
    );
    const candidate = check.rows[0];
    const candidateHash = candidate?.secret_hash;
    if (
      !candidateHash ||
      !/^[a-f0-9]{64}$/.test(candidateHash) ||
      !timingSafeEqual(
        Buffer.from(candidateHash, "hex"),
        Buffer.from(digest(secret), "hex")
      )
    )
      throw new SourceError(401, "UNAUTHORIZED");
    const selected = await tx.query<Source>(
      "SELECT * FROM audience_sources WHERE id=$1 FOR UPDATE",
      [sourceId]
    );
    const source = selected.rows[0];
    if (!source || source.revoked_at)
      throw new SourceError(409, "SOURCE_REVOKED");
    const now = Date.now();
    const changes = parsed.data.recipients
      .map(item => {
        const normalized = typedRecipient(item.value);
        if (source.transport === "bot" && normalized.type === "phone")
          throw new SourceError(400, "BOT_PHONE_NOT_ADDRESSABLE");
        if (item.subscribed && !item.consentAt)
          throw new SourceError(400, "DATED_CONSENT_REQUIRED");
        const consentAt = item.consentAt ? new Date(item.consentAt) : null;
        if (
          consentAt &&
          (!Number.isFinite(consentAt.getTime()) || consentAt.getTime() > now)
        )
          throw new SourceError(400, "CONSENT_TIME_INVALID");
        return {
          ...normalized,
          subscribed: item.subscribed,
          consentAt: consentAt?.toISOString() ?? null,
        };
      })
      .sort((a, b) => a.recipient.localeCompare(b.recipient));
    if (
      new Set(changes.map(change => change.recipient)).size !== changes.length
    )
      throw new SourceError(400, "DUPLICATE_RECIPIENT_IN_EVENT");
    const hash = digest(
      JSON.stringify(
        changes
          .map(({ recipient, subscribed, consentAt }) => ({
            recipient,
            subscribed,
            consentAt,
          }))
          .sort((a, b) => a.recipient.localeCompare(b.recipient))
      )
    );
    const previous = await tx.query<{
      payload_hash: string;
      result: SyncResult;
    }>(
      "SELECT payload_hash,result FROM audience_source_events WHERE source_id=$1 AND event_key=$2",
      [sourceId, parsed.data.eventId]
    );
    if (previous.rowCount) {
      if (previous.rows[0].payload_hash !== hash)
        throw new SourceError(409, "EVENT_ID_CONFLICT");
      await tx.query("COMMIT");
      return { ...previous.rows[0].result, duplicate: true };
    }
    const list = await tx.query<{ chatIds: string }>(
      'SELECT "chatIds" FROM recipient_lists WHERE id=$1 AND "userId"=$2 FOR UPDATE',
      [source.list_id, source.owner_id]
    );
    if (!list.rowCount) throw new SourceError(409, "SOURCE_LIST_UNAVAILABLE");
    const members = listMembers(list.rows[0].chatIds);
    const payload = JSON.stringify(
      changes.map(change => ({
        recipient: change.recipient,
        subscribed: change.subscribed,
        consent_at: change.consentAt,
      }))
    );
    const permission = await tx.query<{ recipient: string; allowed: boolean }>(
      `INSERT INTO contact_permissions(owner_id,kind,recipient,allowed,source,suppressed_at)
      SELECT $1,$2,r.recipient,r.subscribed,$3,CASE WHEN r.subscribed THEN NULL ELSE now() END
      FROM jsonb_to_recordset($4::jsonb) AS r(recipient text,subscribed boolean,consent_at timestamptz)
      ON CONFLICT(owner_id,kind,recipient) DO UPDATE SET
        allowed=CASE WHEN contact_permissions.suppressed_at IS NOT NULL THEN false ELSE EXCLUDED.allowed END,
        source=CASE WHEN contact_permissions.suppressed_at IS NOT NULL AND EXCLUDED.allowed THEN contact_permissions.source ELSE EXCLUDED.source END,
        suppressed_at=CASE WHEN NOT EXCLUDED.allowed THEN COALESCE(contact_permissions.suppressed_at,now()) ELSE contact_permissions.suppressed_at END,updated_at=now()
      RETURNING recipient,allowed`,
      [
        source.owner_id,
        source.transport,
        `CRM:${source.name} [${source.id}]`,
        payload,
      ]
    );
    const allowed = new Map(
      permission.rows.map(row => [row.recipient, row.allowed])
    );
    for (const change of changes) {
      if (allowed.get(change.recipient))
        members.set(change.recipient, change.value);
      else members.delete(change.recipient);
    }
    if (members.size > 50000) throw new SourceError(400, "AUDIENCE_SIZE_LIMIT");
    await tx.query(
      `INSERT INTO audience_source_members(source_id,recipient,declared_subscription,consent_at,last_event_key)
      SELECT $1,r.recipient,r.subscribed,r.consent_at,$2 FROM jsonb_to_recordset($3::jsonb) AS r(recipient text,subscribed boolean,consent_at timestamptz)
      ON CONFLICT(source_id,recipient) DO UPDATE SET declared_subscription=EXCLUDED.declared_subscription,consent_at=EXCLUDED.consent_at,last_event_key=EXCLUDED.last_event_key,updated_at=now()`,
      [source.id, parsed.data.eventId, payload]
    );
    await tx.query(
      'UPDATE recipient_lists SET "chatIds"=$1,"totalCount"=$2 WHERE id=$3 AND "userId"=$4',
      [
        JSON.stringify([...members.values()]),
        members.size,
        source.list_id,
        source.owner_id,
      ]
    );
    const subscribed = permission.rows.filter(row => row.allowed).length;
    const result: SyncResult = {
      applied: true,
      duplicate: false,
      totalCount: members.size,
      subscribed,
      suppressed: changes.length - subscribed,
    };
    await tx.query(
      "INSERT INTO audience_source_events(source_id,event_key,payload_hash,result) VALUES($1,$2,$3,$4)",
      [source.id, parsed.data.eventId, hash, JSON.stringify(result)]
    );
    await tx.query(
      "UPDATE audience_sources SET last_synced_at=now() WHERE id=$1",
      [source.id]
    );
    await tx.query(
      "INSERT INTO audit_events(owner_id,action,target,detail) VALUES($1,'audience.source.synced',$2,$3)",
      [
        source.owner_id,
        String(source.id),
        JSON.stringify({ eventId: parsed.data.eventId, ...result }),
      ]
    );
    await tx.query("COMMIT");
    return result;
  } catch (error) {
    await tx.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    tx.release();
  }
}

export function registerAudienceSourceWebhook(app: Express): void {
  app.post("/api/audience-sources/:id/events", async (req, res) => {
    try {
      const secret = req.headers.authorization?.match(
        /^Bearer ([A-Za-z0-9_-]{40,128})$/
      )?.[1];
      if (!secret) {
        res.status(401).json({ error: "UNAUTHORIZED" });
        return;
      }
      const result = await applyAudienceSourceEvent(
        Number(req.params.id),
        secret,
        req.body
      );
      res.status(200).json(result);
    } catch (error) {
      if (error instanceof SourceError) {
        res.status(error.status).json({ error: error.code });
        return;
      }
      res.status(503).json({ error: "AUDIENCE_SYNC_UNAVAILABLE" });
    }
  });
}
