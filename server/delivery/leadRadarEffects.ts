import { createHash, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { DeliveryError, senderKey, type DeliveryTransport } from "./types";
import { encryptSecret, decryptSecret } from "../security/secrets";

export const LR_SCHEMA = "gptbot.lead-radar.tg-sender.v1" as const;
export const LR_PREFIX = "/api/integrations/lead-radar/v1";
const id = z.string().regex(/^[A-Za-z0-9:_-]{8,160}$/);
const bindingShape = {
  org_id: z.string().regex(/^[A-Za-z0-9:_-]{1,80}$/),
  account_id: z.string().regex(/^lrtgua_[a-f0-9]{32}$/),
  account_ref: z.string().regex(/^[A-Za-z0-9:_-]{16,160}$/),
  sender_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
};
export const lrBindingSchema = z.object(bindingShape).strict();
export type LrBinding = z.infer<typeof lrBindingSchema>;
const publicInquiry = z
  .object({
    policy_version: z.literal("public-business-inquiry-v1"),
    source_url_digest: z.string().regex(/^[a-f0-9]{64}$/),
    approval_id: z.string().regex(/^lrtgap_[a-f0-9]{32}$/),
    selection_digest: z.string().regex(/^[a-f0-9]{64}$/),
    content_digest: z.string().regex(/^[a-f0-9]{64}$/),
    recipient_id: z.string().regex(/^lrtgcr_[a-f0-9]{32}$/),
    first_contact_only: z.literal(true),
  })
  .strict();
export const lrCommandSchema = z
  .object({
    schema: z.literal(LR_SCHEMA),
    binding: lrBindingSchema,
    effect_id: id,
    payload_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    recipient: z.string().regex(/^lrpeer:[a-f0-9]{32}$/),
    text: z
      .string()
      .min(1)
      .max(4096)
      .refine(v => !v.includes("\0") && Buffer.byteLength(v) <= 16384),
    authorization: z
      .object({
        basis: z.enum([
          "documented_consent",
          "inbound_request",
          "existing_relationship",
          "contractual_relationship",
          "public_business_inquiry",
        ]),
        reference: id,
        expires_at: z.string().datetime(),
        public_inquiry: publicInquiry.optional(),
      })
      .strict()
      .refine(value =>
        value.basis === "public_business_inquiry"
          ? Boolean(value.public_inquiry)
          : !value.public_inquiry
      ),
    paid_message_policy: z.literal("reject"),
    allow_paid_floodskip: z.literal(false),
    parse_mode: z.literal("None"),
  })
  .strict();
export type LrCommand = z.infer<typeof lrCommandSchema>;
export const lrEffectKeySchema = z
  .object({
    schema: z.literal(LR_SCHEMA),
    binding: lrBindingSchema,
    effect_id: id,
    payload_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type LrEffectKey = z.infer<typeof lrEffectKeySchema>;
export type LrConfig = {
  binding: LrBinding;
  ownerId: number;
  token: string;
  minIntervalSeconds: number;
  contactIntervalSeconds: number;
  publicInquiryEnabled: boolean;
};
export type LrResolvedUser =
  | {
      kind: "user";
      userId: string;
      accessHash: string;
      username: string | null;
    }
  | { kind: "bot" | "group" | "channel" | "unknown" };
export type LrResolver = (
  ownerId: number,
  username: string,
  fingerprint: string,
  signal: AbortSignal
) => Promise<LrResolvedUser>;
export type LrVerifier = (
  ownerId: number,
  fingerprint: string,
  signal: AbortSignal
) => Promise<void>;
export type LrResult = {
  schema: typeof LR_SCHEMA;
  binding: LrBinding;
  effect_id: string;
  payload_sha256: string;
  state:
    | "accepted"
    | "rejected"
    | "unknown"
    | "inflight"
    | "cancelled"
    | "not_found";
  code?: string;
  provider_message_id?: string;
  retry_after_seconds?: number;
};
export class LrIntegrationError extends Error {
  constructor(
    readonly code: "SCOPE_MISMATCH" | "PAYLOAD_CONFLICT" | "INVALID_PAYLOAD"
  ) {
    super(code);
  }
}

export function integrationConfig(
  env: NodeJS.ProcessEnv = process.env
): LrConfig | null {
  if (env.LEAD_RADAR_INTEGRATION_ENABLED !== "true") return null;
  const ownerId = Number(env.LEAD_RADAR_INTEGRATION_OWNER_ID);
  const parsed = lrBindingSchema.safeParse({
    org_id: env.LEAD_RADAR_INTEGRATION_ORG_ID,
    account_id: env.LEAD_RADAR_INTEGRATION_ACCOUNT_ID,
    account_ref: env.LEAD_RADAR_INTEGRATION_ACCOUNT_REF,
    sender_fingerprint: env.LEAD_RADAR_INTEGRATION_SENDER_FINGERPRINT,
  });
  const token = env.LEAD_RADAR_INTEGRATION_TOKEN ?? "";
  if (
    !parsed.success ||
    !Number.isSafeInteger(ownerId) ||
    ownerId < 1 ||
    env.LEAD_RADAR_INTEGRATION_OWNER_ID !== String(ownerId) ||
    !/^[A-Za-z0-9_-]{43,128}$/.test(token)
  )
    return null;
  return {
    binding: parsed.data,
    ownerId,
    token,
    minIntervalSeconds: 120,
    contactIntervalSeconds: 86400,
    publicInquiryEnabled:
      env.LEAD_RADAR_PUBLIC_BUSINESS_INQUIRY_ENABLED === "true",
  };
}

/** Ownership claim is fail-closed even during credential/configuration drift. */
export function leadRadarOwnsSender(
  ownerId: number,
  kind: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return (
    env.LEAD_RADAR_INTEGRATION_ENABLED === "true" &&
    kind === "mtproto" &&
    Number.isSafeInteger(ownerId) &&
    ownerId > 0 &&
    env.LEAD_RADAR_INTEGRATION_OWNER_ID === String(ownerId)
  );
}

export function commandDigest(
  command: Omit<LrCommand, "payload_sha256"> | LrCommand
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        LR_SCHEMA,
        command.binding.org_id,
        command.binding.account_id,
        command.binding.account_ref,
        command.binding.sender_fingerprint,
        command.effect_id,
        command.recipient,
        command.text,
        command.authorization.basis,
        command.authorization.reference,
        command.authorization.expires_at,
        command.paid_message_policy,
        command.allow_paid_floodskip,
        command.parse_mode,
        command.authorization.public_inquiry
          ? [
              command.authorization.public_inquiry.policy_version,
              command.authorization.public_inquiry.source_url_digest,
              command.authorization.public_inquiry.approval_id,
              command.authorization.public_inquiry.selection_digest,
              command.authorization.public_inquiry.content_digest,
              command.authorization.public_inquiry.recipient_id,
              command.authorization.public_inquiry.first_contact_only,
            ]
          : null,
      ])
    )
    .digest("hex");
}

export function effectRandomId(config: LrConfig, effectId: string): string {
  const hex = createHash("sha256")
    .update(
      JSON.stringify([LR_SCHEMA, config.ownerId, config.binding, effectId])
    )
    .digest("hex");
  return (
    BigInt(`0x${hex.slice(0, 16)}`) & ((1n << 63n) - 1n) || 1n
  ).toString();
}

function sameBinding(a: LrBinding, b: LrBinding) {
  return Object.keys(bindingShape).every(
    k => a[k as keyof LrBinding] === b[k as keyof LrBinding]
  );
}
function checkKey(config: LrConfig, key: LrEffectKey) {
  if (!sameBinding(config.binding, key.binding))
    throw new LrIntegrationError("SCOPE_MISMATCH");
}
function envelope(
  key: LrEffectKey,
  result: Pick<
    LrResult,
    "state" | "code" | "provider_message_id" | "retry_after_seconds"
  >
): LrResult {
  return {
    schema: LR_SCHEMA,
    binding: key.binding,
    effect_id: key.effect_id,
    payload_sha256: key.payload_sha256,
    ...result,
  };
}
type EffectRow = {
  payload_sha256: string;
  state: string;
  code: string | null;
  provider_message_id: string | null;
  available_at: string | Date | null;
  random_id: string;
};
function receipt(key: LrEffectKey, row: EffectRow | undefined): LrResult {
  if (!row) return envelope(key, { state: "not_found" });
  if (row.payload_sha256 !== key.payload_sha256)
    throw new LrIntegrationError("PAYLOAD_CONFLICT");
  if (row.state === "accepted" && row.provider_message_id)
    return envelope(key, {
      state: "accepted",
      provider_message_id: row.provider_message_id,
    });
  if (row.state === "rejected" || row.state === "deferred")
    return envelope(key, {
      state: "rejected",
      code: row.code ?? "provider_rejected",
      ...(row.available_at
        ? {
            retry_after_seconds: Math.max(
              1,
              Math.ceil(
                (new Date(row.available_at).getTime() - Date.now()) / 1000
              )
            ),
          }
        : {}),
    });
  return envelope(key, {
    state:
      row.state === "cancelled"
        ? "cancelled"
        : row.state === "inflight"
          ? "inflight"
          : "unknown",
  });
}

export function classifyIntegrationFailure(error: unknown): {
  state: "rejected" | "unknown";
  code?: string;
  retry_after_seconds?: number;
} {
  if (!(error instanceof DeliveryError)) return { state: "unknown" };
  if (error.category === "cooldown" || error.category === "slowmode") {
    const wait = Math.ceil(error.retryAfterSeconds ?? 60);
    if (!Number.isSafeInteger(wait) || wait < 1 || wait > 2147483647)
      return { state: "unknown" };
    return {
      state: "rejected",
      code: error.category === "slowmode" ? "slow_mode" : "flood_wait",
      retry_after_seconds: wait,
    };
  }
  if (error.category === "auth")
    return { state: "rejected", code: "account_session_missing" };
  if (error.category === "restricted")
    return { state: "rejected", code: "account_restricted" };
  if (error.category === "recipient")
    return { state: "rejected", code: "peer_invalid" };
  return { state: "rejected", code: "provider_rejected" };
}

/** One immutable effect, no scheduler and no automatic send retry. SQL stays in this repository. */
export class LeadRadarEffects {
  constructor(
    private readonly pool: Pool,
    private readonly transport: DeliveryTransport,
    private readonly currentFingerprint: (
      ownerId: number
    ) => Promise<string | null>,
    private readonly liveEnabled: () => boolean = () =>
      process.env.LIVE_SEND_ENABLED === "true",
    private readonly resolver?: LrResolver,
    private readonly maskedLabel: (
      ownerId: number
    ) => Promise<string> = async () => "TG Sender",
    private readonly verifier?: LrVerifier
  ) {}

  private async find(
    client: Pick<PoolClient, "query">,
    config: LrConfig,
    key: LrEffectKey
  ) {
    const result = await client.query<EffectRow>(
      "SELECT payload_sha256,state,code,provider_message_id,available_at,random_id FROM lead_radar_effects WHERE owner_id=$1 AND org_id=$2 AND account_id=$3 AND effect_id=$4",
      [
        config.ownerId,
        config.binding.org_id,
        config.binding.account_id,
        key.effect_id,
      ]
    );
    return result.rows[0];
  }

  async status(config: LrConfig) {
    const fingerprint = await this.currentFingerprint(config.ownerId);
    const key = senderKey(config.ownerId, "mtproto");
    const state = await this.pool.query(
      `SELECT state,cooldown_until,next_send_at FROM sender_controls WHERE sender_key=$1`,
      [key]
    );
    const active = await this.pool.query(
      `SELECT EXISTS(SELECT 1 FROM delivery_campaigns c WHERE c.sender_key=$1 AND (c.status IN ('queued','running','stopping') OR EXISTS(SELECT 1 FROM deliveries d WHERE d.campaign_id=c.id AND d.state='inflight'))) AS active`,
      [key]
    );
    const row = state.rows[0];
    const schema = await this.pool.query(
      `SELECT to_regclass('lead_radar_effects') IS NOT NULL AND to_regclass('lead_radar_peers') IS NOT NULL AND to_regclass('lead_radar_session_checks') IS NOT NULL AS ready`
    );
    const waitUntil = Math.max(
      new Date(row?.cooldown_until ?? 0).getTime(),
      new Date(row?.next_send_at ?? 0).getTime()
    );
    let reason: string | null = null;
    if (!schema.rows[0]?.ready) reason = "migration_required";
    else if (!this.liveEnabled()) reason = "live_send_disabled";
    else if (!fingerprint || fingerprint !== config.binding.sender_fingerprint)
      reason = "sender_changed_or_missing";
    else if (active.rows[0]?.active) reason = "legacy_campaign_active";
    else if (row && !["READY", "COOLDOWN"].includes(row.state))
      reason = "sender_requires_review";
    else if (waitUntil > Date.now()) reason = "sender_cooldown";
    const verified = schema.rows[0]?.ready
      ? await this.pool.query(
          `SELECT verified_at FROM lead_radar_session_checks WHERE owner_id=$1 AND sender_fingerprint=$2 AND verified_at>now()-interval '24 hours'`,
          [config.ownerId, config.binding.sender_fingerprint]
        )
      : { rows: [] };
    return {
      schema: LR_SCHEMA,
      binding: config.binding,
      provider_verified_at: verified.rows[0]?.verified_at
        ? new Date(verified.rows[0].verified_at).toISOString()
        : null,
      ready: reason === null,
      reason_code: reason,
      checked_at: new Date().toISOString(),
      masked_label: await this.maskedLabel(config.ownerId),
      retry_after_seconds:
        reason === "sender_cooldown"
          ? Math.max(1, Math.ceil((waitUntil - Date.now()) / 1000))
          : null,
      capabilities: {
        text: true,
        media: false,
        durable_idempotency: true,
        sender_lock: true,
        persisted_cooldown: true,
        independent_scheduler: false,
        opaque_peer_refs: true,
        username_resolution: Boolean(this.resolver),
        public_business_inquiry: config.publicInquiryEnabled,
      },
    };
  }

  async probe(config: LrConfig, binding: LrBinding) {
    if (!sameBinding(config.binding, binding))
      throw new LrIntegrationError("SCOPE_MISMATCH");
    const blocked = async (reason: string, retry: number | null = null) => ({
      ...(await this.status(config)),
      ready: false,
      reason_code: reason,
      retry_after_seconds: retry,
    });
    return this.withLock<Awaited<ReturnType<LeadRadarEffects["status"]>>>(
      config,
      () => blocked("sender_busy", 2),
      async (client, lost) => {
        const status = await this.status(config);
        if (!status.ready || !this.verifier)
          return {
            ...status,
            ready: false,
            reason_code: status.reason_code ?? "verifier_unavailable",
          };
        await client.query(
          `INSERT INTO lead_radar_session_checks(owner_id,sender_fingerprint,verified_at) VALUES($1,$2,NULL) ON CONFLICT(owner_id,sender_fingerprint) DO UPDATE SET verified_at=NULL,attempted_at=now()`,
          [config.ownerId, binding.sender_fingerprint]
        );
        const controller = new AbortController(),
          abort = () => controller.abort();
        client.on("error", abort);
        const timer = setTimeout(abort, 9000);
        try {
          await this.verifier(
            config.ownerId,
            binding.sender_fingerprint,
            controller.signal
          );
          if (controller.signal.aborted || lost())
            return blocked("session_probe_unavailable");
          await client.query(
            `UPDATE lead_radar_session_checks SET verified_at=now(),attempted_at=now() WHERE owner_id=$1 AND sender_fingerprint=$2`,
            [config.ownerId, binding.sender_fingerprint]
          );
          return this.status(config);
        } catch (error) {
          const failure = classifyIntegrationFailure(error);
          if (!lost()) {
            const key = senderKey(config.ownerId, "mtproto");
            await client.query(
              `INSERT INTO sender_controls(sender_key,owner_id,kind) VALUES($1,$2,'mtproto') ON CONFLICT DO NOTHING`,
              [key, config.ownerId]
            );
            if (failure.code === "flood_wait")
              await client.query(
                `UPDATE sender_controls SET state='COOLDOWN',cooldown_until=GREATEST(COALESCE(cooldown_until,now()),now()+$2*interval '1 second'),reason='LR_PROBE_FLOOD_WAIT',updated_at=now() WHERE sender_key=$1`,
                [key, failure.retry_after_seconds]
              );
            if (
              failure.code === "account_session_missing" ||
              failure.code === "account_restricted"
            )
              await client.query(
                `UPDATE sender_controls SET state=$2,reason='LR_PROBE_REJECTED',updated_at=now() WHERE sender_key=$1`,
                [
                  key,
                  failure.code === "account_session_missing"
                    ? "AUTH_REQUIRED"
                    : "REVIEW_REQUIRED",
                ]
              );
          }
          return blocked("session_probe_unavailable");
        } finally {
          clearTimeout(timer);
          client.removeListener("error", abort);
        }
      }
    );
  }

  async resolve(config: LrConfig, binding: LrBinding, username: string) {
    if (!sameBinding(config.binding, binding))
      throw new LrIntegrationError("SCOPE_MISMATCH");
    if (!/^[a-z][a-z0-9_]{4,31}$/.test(username))
      throw new LrIntegrationError("INVALID_PAYLOAD");
    const base = { schema: LR_SCHEMA, binding: config.binding, username };
    type Resolution = typeof base & {
      status: "resolved" | "blocked" | "unresolved";
      kind: "user" | "bot" | "group" | "channel" | "unknown";
      peer_ref: string | null;
      verified_at: string | null;
      expires_at: string | null;
      reason_code: string | null;
      retry_after_seconds: number | null;
    };
    const blocked = (
      reason: string,
      wait: number | null = null
    ): Resolution => ({
      ...base,
      status: "blocked",
      kind: "unknown",
      peer_ref: null,
      verified_at: null,
      expires_at: null,
      reason_code: reason,
      retry_after_seconds: wait,
    });
    return this.withLock<Resolution>(
      config,
      () => blocked("sender_busy", 2),
      async (client, connectionLost) => {
        const ready = await this.status(config);
        if (!ready.ready || !this.resolver)
          return blocked(
            ready.reason_code ?? "resolver_unavailable",
            ready.retry_after_seconds
          );
        const key = senderKey(config.ownerId, "mtproto");
        await client.query(
          `INSERT INTO sender_controls(sender_key,owner_id,kind) VALUES($1,$2,'mtproto') ON CONFLICT DO NOTHING`,
          [key, config.ownerId]
        );
        await client.query(
          `UPDATE sender_controls SET next_send_at=GREATEST(next_send_at,now()+interval '5 seconds'),updated_at=now() WHERE sender_key=$1`,
          [key]
        );
        const controller = new AbortController();
        const abort = () => controller.abort();
        const timer = setTimeout(abort, 30000);
        client.on("error", abort);
        try {
          const resolved = await this.resolver(
            config.ownerId,
            username,
            config.binding.sender_fingerprint,
            controller.signal
          );
          if (controller.signal.aborted || connectionLost())
            return blocked("lookup_unavailable");
          if (resolved.kind !== "user")
            return {
              ...base,
              status: "unresolved",
              kind: resolved.kind,
              peer_ref: null,
              verified_at: null,
              expires_at: null,
              reason_code: "not_private_user",
              retry_after_seconds: null,
            };
          if (
            !/^[1-9][0-9]{0,19}$/.test(resolved.userId) ||
            !/^-?[0-9]{1,20}$/.test(resolved.accessHash)
          )
            return blocked("lookup_unavailable");
          const peerDigest = createHash("sha256")
            .update(
              JSON.stringify([
                config.ownerId,
                config.binding.sender_fingerprint,
                resolved.userId,
              ])
            )
            .digest("hex");
          const old = await client.query(
            `SELECT peer_ref FROM lead_radar_peers WHERE owner_id=$1 AND org_id=$2 AND account_id=$3 AND sender_fingerprint=$4 AND peer_digest=$5`,
            [
              config.ownerId,
              binding.org_id,
              binding.account_id,
              binding.sender_fingerprint,
              peerDigest,
            ]
          );
          const peerRef =
            old.rows[0]?.peer_ref ??
            `lrpeer:${randomBytes(16).toString("hex")}`;
          const context = `lead-radar-peer:${config.ownerId}:${binding.org_id}:${binding.account_id}:${peerRef}`;
          const secret = encryptSecret(
            JSON.stringify({
              userId: resolved.userId,
              accessHash: resolved.accessHash,
            }),
            context
          );
          await client.query("BEGIN");
          try {
            await client.query(
              `UPDATE lead_radar_peers SET expires_at=now() WHERE owner_id=$1 AND org_id=$2 AND account_id=$3 AND username=$4 AND peer_digest<>$5`,
              [
                config.ownerId,
                binding.org_id,
                binding.account_id,
                username,
                peerDigest,
              ]
            );
            const saved = await client.query(
              `INSERT INTO lead_radar_peers(owner_id,org_id,account_id,account_ref,sender_fingerprint,peer_ref,peer_digest,username,peer_secret,verified_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),now()+interval '24 hours') ON CONFLICT(owner_id,org_id,account_id,sender_fingerprint,peer_digest) DO UPDATE SET username=EXCLUDED.username,peer_secret=EXCLUDED.peer_secret,verified_at=now(),expires_at=now()+interval '24 hours' RETURNING peer_ref,verified_at,expires_at`,
              [
                config.ownerId,
                binding.org_id,
                binding.account_id,
                binding.account_ref,
                binding.sender_fingerprint,
                peerRef,
                peerDigest,
                username,
                secret,
              ]
            );
            await client.query("COMMIT");
            const row = saved.rows[0];
            return {
              ...base,
              status: "resolved",
              kind: "user",
              peer_ref: row.peer_ref,
              verified_at: new Date(row.verified_at).toISOString(),
              expires_at: new Date(row.expires_at).toISOString(),
              reason_code: null,
              retry_after_seconds: null,
            };
          } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            throw error;
          }
        } catch (error) {
          const failure = classifyIntegrationFailure(error);
          if (failure.code === "flood_wait") {
            await client.query(
              `UPDATE sender_controls SET state='COOLDOWN',cooldown_until=GREATEST(COALESCE(cooldown_until,now()),now()+$2*interval '1 second'),reason='LR_LOOKUP_FLOOD_WAIT',updated_at=now() WHERE sender_key=$1`,
              [key, failure.retry_after_seconds]
            );
            return blocked(
              "sender_cooldown",
              failure.retry_after_seconds ?? 60
            );
          }
          return blocked("lookup_unavailable");
        } finally {
          clearTimeout(timer);
          client.removeListener("error", abort);
        }
      }
    );
  }

  async read(config: LrConfig, key: LrEffectKey) {
    checkKey(config, key);
    const first = await this.find(this.pool, config, key);
    if (first?.state !== "inflight") return receipt(key, first);
    return this.withLock(
      config,
      () => receipt(key, first),
      async client => {
        const current = await this.find(client, config, key);
        receipt(key, current);
        if (current?.state === "inflight") {
          await client.query("BEGIN");
          try {
            await client.query(
              `UPDATE lead_radar_effects SET state='unknown',code='worker_interrupted',updated_at=now() WHERE owner_id=$1 AND org_id=$2 AND account_id=$3 AND effect_id=$4 AND state='inflight'`,
              [
                config.ownerId,
                config.binding.org_id,
                config.binding.account_id,
                key.effect_id,
              ]
            );
            await client.query(
              `UPDATE sender_controls SET state='REVIEW_REQUIRED',reason='LR_EFFECT_UNKNOWN',updated_at=now() WHERE sender_key=$1`,
              [senderKey(config.ownerId, "mtproto")]
            );
            await client.query("COMMIT");
          } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            throw error;
          }
          return envelope(key, { state: "unknown" });
        }
        return receipt(key, current);
      }
    );
  }

  private async withLock<T>(
    config: LrConfig,
    busy: () => T | Promise<T>,
    work: (client: PoolClient, connectionLost: () => boolean) => Promise<T>
  ): Promise<T> {
    const client = await this.pool.connect();
    const lockName = `tg-sender:${senderKey(config.ownerId, "mtproto")}`;
    let locked = false,
      broken = false;
    const onError = () => {
      broken = true;
    };
    client.on("error", onError);
    try {
      const lock = await client.query(
        "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",
        [lockName]
      );
      locked = lock.rows[0]?.locked === true;
      if (!locked) return busy();
      return await work(client, () => broken);
    } catch (error) {
      broken = true;
      throw error;
    } finally {
      if (locked && !broken)
        await client
          .query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
            lockName,
          ])
          .catch(() => {
            broken = true;
          });
      client.removeListener("error", onError);
      client.release(broken);
    }
  }

  async cancel(config: LrConfig, key: LrEffectKey): Promise<LrResult> {
    checkKey(config, key);
    return this.withLock(
      config,
      () => envelope(key, { state: "inflight" }),
      async client => {
        const existing = await this.find(client, config, key);
        if (existing) {
          receipt(key, existing);
          if (
            [
              "accepted",
              "unknown",
              "inflight",
              "rejected",
              "cancelled",
            ].includes(existing.state)
          )
            return receipt(key, existing);
          await client.query(
            "UPDATE lead_radar_effects SET state='cancelled',updated_at=now() WHERE owner_id=$1 AND org_id=$2 AND account_id=$3 AND effect_id=$4 AND state='deferred'",
            [
              config.ownerId,
              config.binding.org_id,
              config.binding.account_id,
              key.effect_id,
            ]
          );
        } else {
          await client.query(
            `INSERT INTO lead_radar_effects(owner_id,org_id,account_id,account_ref,sender_fingerprint,effect_id,payload_sha256,random_id,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'cancelled')`,
            [
              config.ownerId,
              config.binding.org_id,
              config.binding.account_id,
              config.binding.account_ref,
              config.binding.sender_fingerprint,
              key.effect_id,
              key.payload_sha256,
              effectRandomId(config, key.effect_id),
            ]
          );
        }
        return envelope(key, { state: "cancelled" });
      }
    );
  }

  async dispatch(config: LrConfig, raw: unknown): Promise<LrResult> {
    const parsed = lrCommandSchema.safeParse(raw);
    if (!parsed.success) throw new LrIntegrationError("INVALID_PAYLOAD");
    const command = parsed.data;
    checkKey(config, command);
    if (commandDigest(command) !== command.payload_sha256)
      throw new LrIntegrationError("INVALID_PAYLOAD");
    return this.withLock(
      config,
      () =>
        envelope(command, {
          state: "rejected",
          code: "flood_wait",
          retry_after_seconds: 2,
        }),
      async (client, connectionLost) => {
        const key = senderKey(config.ownerId, "mtproto");
        // Holding the same lock as the old worker proves abandoned effects are not in a healthy dispatcher.
        const abandoned = await client.query(
          `UPDATE lead_radar_effects SET state='unknown',code='worker_interrupted',updated_at=now() WHERE owner_id=$1 AND state='inflight' RETURNING effect_id`,
          [config.ownerId]
        );
        if (abandoned.rowCount)
          await client.query(
            `UPDATE sender_controls SET state='REVIEW_REQUIRED',reason='LR_EFFECT_UNKNOWN',updated_at=now() WHERE sender_key=$1`,
            [key]
          );
        const existing = await this.find(client, config, command);
        if (existing) {
          const previous = receipt(command, existing);
          if (
            existing.state !== "deferred" ||
            new Date(existing.available_at ?? 0).getTime() > Date.now()
          )
            return previous;
        }
        if (Date.parse(command.authorization.expires_at) <= Date.now())
          return envelope(command, {
            state: "rejected",
            code: "provider_rejected",
          });
        if (
          command.authorization.basis === "public_business_inquiry" &&
          !config.publicInquiryEnabled
        )
          return envelope(command, {
            state: "rejected",
            code: "provider_rejected",
          });
        const readiness = await this.status(config);
        if (!readiness.ready)
          return envelope(command, {
            state: "rejected",
            code:
              readiness.reason_code === "sender_cooldown"
                ? "flood_wait"
                : "account_session_missing",
            ...(readiness.retry_after_seconds
              ? { retry_after_seconds: readiness.retry_after_seconds }
              : {}),
          });
        const proof = await client.query(
          `SELECT peer_secret,username FROM lead_radar_peers WHERE owner_id=$1 AND org_id=$2 AND account_id=$3 AND account_ref=$4 AND sender_fingerprint=$5 AND peer_ref=$6 AND expires_at>now()`,
          [
            config.ownerId,
            command.binding.org_id,
            command.binding.account_id,
            command.binding.account_ref,
            command.binding.sender_fingerprint,
            command.recipient,
          ]
        );
        if (!proof.rows[0])
          return envelope(command, { state: "rejected", code: "peer_invalid" });
        const peer = JSON.parse(
          decryptSecret(
            proof.rows[0].peer_secret,
            `lead-radar-peer:${config.ownerId}:${command.binding.org_id}:${command.binding.account_id}:${command.recipient}`
          )
        ) as { userId: string; accessHash: string };
        if (
          !/^[1-9][0-9]{0,19}$/.test(peer.userId) ||
          !/^-?[0-9]{1,20}$/.test(peer.accessHash)
        )
          return envelope(command, { state: "rejected", code: "peer_invalid" });
        const recipient = `chat:${peer.userId}`;
        const aliases = [recipient, `username:${proof.rows[0].username}`];
        if (command.authorization.basis === "public_business_inquiry") {
          const prior = await client.query(
            `SELECT EXISTS(SELECT 1 FROM lead_radar_effects WHERE owner_id=$1 AND recipient=$2 AND state IN ('accepted','unknown','inflight')) OR EXISTS(SELECT 1 FROM deliveries d JOIN delivery_campaigns c ON c.id=d.campaign_id WHERE c.owner_id=$1 AND c.kind='mtproto' AND d.recipient=ANY($3::text[]) AND d.state IN ('accepted','unknown','inflight')) AS contacted`,
            [config.ownerId, recipient, aliases]
          );
          if (prior.rows[0]?.contacted)
            return envelope(command, {
              state: "rejected",
              code: "privacy_restricted",
            });
        }
        const denied = await client.query(
          `SELECT allowed,suppressed_at FROM contact_permissions WHERE owner_id=$1 AND kind='mtproto' AND recipient=ANY($2::text[]) AND (NOT allowed OR suppressed_at IS NOT NULL)`,
          [config.ownerId, aliases]
        );
        if (
          denied.rows[0] &&
          (!denied.rows[0].allowed || denied.rows[0].suppressed_at)
        )
          return envelope(command, {
            state: "rejected",
            code: "privacy_restricted",
          });
        const contact = await client.query(
          `SELECT MAX(next_send_at) AS next_send_at FROM contact_delivery_controls WHERE sender_key=$1 AND recipient=ANY($2::text[])`,
          [key, aliases]
        );
        const next = new Date(contact.rows[0]?.next_send_at ?? 0).getTime();
        if (next > Date.now())
          return envelope(command, {
            state: "rejected",
            code: "slow_mode",
            retry_after_seconds: Math.max(
              1,
              Math.ceil((next - Date.now()) / 1000)
            ),
          });
        const randomId =
          existing?.random_id ?? effectRandomId(config, command.effect_id);
        await client.query("BEGIN");
        try {
          await client.query(
            `INSERT INTO sender_controls(sender_key,owner_id,kind) VALUES($1,$2,'mtproto') ON CONFLICT DO NOTHING`,
            [key, config.ownerId]
          );
          await client.query(
            `UPDATE sender_controls SET state='READY',cooldown_until=NULL,reason=NULL,updated_at=now() WHERE sender_key=$1 AND state='COOLDOWN' AND cooldown_until<=now()`,
            [key]
          );
          if (existing)
            await client.query(
              `UPDATE lead_radar_effects SET state='inflight',attempt_count=attempt_count+1,code=NULL,available_at=NULL,updated_at=now() WHERE owner_id=$1 AND org_id=$2 AND account_id=$3 AND effect_id=$4 AND state='deferred'`,
              [
                config.ownerId,
                command.binding.org_id,
                command.binding.account_id,
                command.effect_id,
              ]
            );
          else
            await client.query(
              `INSERT INTO lead_radar_effects(owner_id,org_id,account_id,account_ref,sender_fingerprint,effect_id,payload_sha256,random_id,recipient,peer_ref,state,attempt_count) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'inflight',1)`,
              [
                config.ownerId,
                command.binding.org_id,
                command.binding.account_id,
                command.binding.account_ref,
                command.binding.sender_fingerprint,
                command.effect_id,
                command.payload_sha256,
                randomId,
                recipient,
                command.recipient,
              ]
            );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => {});
          throw error;
        }
        const controller = new AbortController();
        const abort = () => controller.abort();
        client.on("error", abort);
        const timeout = setTimeout(abort, 30000);
        let result: Pick<
          LrResult,
          "state" | "code" | "provider_message_id" | "retry_after_seconds"
        >;
        try {
          if (connectionLost()) throw new Error("LOCK_LOST");
          const sent = await this.transport.send({
            ownerId: config.ownerId,
            kind: "mtproto",
            recipient,
            message: command.text,
            parseMode: "None",
            deliveryId: command.effect_id,
            randomId,
            signal: controller.signal,
            senderFingerprint: config.binding.sender_fingerprint,
            resolvedPeer: peer,
          });
          result =
            !controller.signal.aborted &&
            !connectionLost() &&
            sent.messageId &&
            /^[1-9][0-9]{0,19}$/.test(sent.messageId)
              ? { state: "accepted", provider_message_id: sent.messageId }
              : { state: "unknown" };
        } catch (error) {
          result =
            controller.signal.aborted || connectionLost()
              ? { state: "unknown" }
              : classifyIntegrationFailure(error);
        } finally {
          clearTimeout(timeout);
          client.removeListener("error", abort);
        }
        if (connectionLost()) return envelope(command, { state: "unknown" });
        await client.query("BEGIN");
        try {
          const deferred =
            result.state === "rejected" &&
            ["flood_wait", "slow_mode"].includes(result.code ?? "");
          await client.query(
            `UPDATE lead_radar_effects SET state=$5,code=$6,provider_message_id=$7,available_at=CASE WHEN $8::int IS NULL THEN NULL ELSE now()+$8*interval '1 second' END,updated_at=now() WHERE owner_id=$1 AND org_id=$2 AND account_id=$3 AND effect_id=$4 AND state='inflight'`,
            [
              config.ownerId,
              command.binding.org_id,
              command.binding.account_id,
              command.effect_id,
              deferred ? "deferred" : result.state,
              result.code ?? null,
              result.provider_message_id ?? null,
              deferred ? result.retry_after_seconds : null,
            ]
          );
          await client.query(
            `UPDATE sender_controls SET next_send_at=GREATEST(next_send_at,now()+$2*interval '1 second'),updated_at=now() WHERE sender_key=$1`,
            [key, config.minIntervalSeconds]
          );
          if (result.code === "flood_wait")
            await client.query(
              `UPDATE sender_controls SET state='COOLDOWN',cooldown_until=GREATEST(COALESCE(cooldown_until,now()),now()+$2*interval '1 second'),reason='LR_FLOOD_WAIT',updated_at=now() WHERE sender_key=$1`,
              [key, result.retry_after_seconds]
            );
          if (
            result.state === "unknown" ||
            result.code === "account_restricted" ||
            result.code === "account_session_missing"
          )
            await client.query(
              `UPDATE sender_controls SET state=$2,reason=$3,updated_at=now() WHERE sender_key=$1`,
              [
                key,
                result.code === "account_session_missing"
                  ? "AUTH_REQUIRED"
                  : "REVIEW_REQUIRED",
                result.state === "unknown"
                  ? "LR_EFFECT_UNKNOWN"
                  : "LR_SENDER_REJECTED",
              ]
            );
          if (
            result.state === "accepted" ||
            result.state === "unknown" ||
            result.code === "slow_mode"
          )
            await client.query(
              `INSERT INTO contact_delivery_controls(sender_key,recipient,next_send_at,last_accepted_at) VALUES($1,$2,now()+$3*interval '1 second',CASE WHEN $4 THEN now() ELSE NULL END) ON CONFLICT(sender_key,recipient) DO UPDATE SET next_send_at=GREATEST(contact_delivery_controls.next_send_at,EXCLUDED.next_send_at),last_accepted_at=COALESCE(EXCLUDED.last_accepted_at,contact_delivery_controls.last_accepted_at)`,
              [
                key,
                recipient,
                result.code === "slow_mode"
                  ? result.retry_after_seconds
                  : config.contactIntervalSeconds,
                result.state === "accepted",
              ]
            );
          if (result.code === "peer_invalid")
            await client.query(
              `INSERT INTO contact_permissions(owner_id,kind,recipient,allowed,source,suppressed_at) VALUES($1,'mtproto',$2,false,'lead_radar:recipient_rejected',now()) ON CONFLICT(owner_id,kind,recipient) DO UPDATE SET allowed=false,suppressed_at=COALESCE(contact_permissions.suppressed_at,now()),source='lead_radar:recipient_rejected',updated_at=now()`,
              [config.ownerId, recipient]
            );
          await client.query("COMMIT");
        } catch {
          await client.query("ROLLBACK").catch(() => {});
          return envelope(command, { state: "unknown" });
        }
        return envelope(command, result);
      }
    );
  }
}
