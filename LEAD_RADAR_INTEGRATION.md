# Lead Radar / TG Sender private transport

The Lead Radar campaign ledger is the only campaign scheduler. TG Sender executes one immutable text effect, stores its outcome, and owns the existing Telegram sender lock. All added gates default off. No runtime token, Telegram session, database credential or live contact is included in this change.

## Runtime boundary

Node and Cloudflare use the same Express registration at `/api/integrations/lead-radar/v1`:

- `GET /status`: configuration readiness, exact binding, ready/reason_code, checked_at, masked_label, cooldown, capabilities and provider_verified_at. It never calls Telegram. A stored provider verification is scoped to the credential fingerprint and expires after 24 hours.
- `POST /session/probe`: strict `{schema,binding}`. An explicit bounded `getMe` under the same sender lock verifies that Telegram still accepts the pinned session. Connect must require a fresh successful provider_verified_at from this probe; database isActive alone is not online verification.
- `POST /contacts/resolve`: `{schema,binding,username}`. Lowercase public username only, one actual account lookup under the sender lock. User-only encrypted peer vault (24 hours), opaque `lrpeer:<hex32>` returned. No phone imports, dialog enumeration, bot/channel/group execution or foreign Bridge references.
- `POST /effects`: full immutable command plus `Idempotency-Key: effect_id`. Plain text only. SHA-256 includes exact scope, authorization and public-inquiry proof. The same effect cannot change payload. Telegram random_id is persisted before the call.
- `GET /effects/:effectId`: `X-Payload-SHA256` required. An abandoned inflight result becomes unknown only after acquiring the same sender lock, without sending anything.
- `POST /effects/:effectId/cancel`: exact effect-key body. Cancels absent/deferred work; accepted/unknown/inflight stays honest. Cancel does not retract a sent message.

Every request requires `Authorization: Bearer <dedicated integration token>`. Browser Origin requests are rejected. Owner web passwords and cookies are never runtime credentials. Authentication pins the exact org, LR account, gateway reference, TG owner and credential fingerprint. A replaced Telegram session requires explicit rebind and fresh contact verification.

TG Sender configuration (all must be set deliberately):

```
LEAD_RADAR_INTEGRATION_ENABLED=false
LEAD_RADAR_INTEGRATION_OWNER_ID=<canonical positive integer>
LEAD_RADAR_INTEGRATION_ORG_ID=<exact LR org>
LEAD_RADAR_INTEGRATION_ACCOUNT_ID=lrtgua_<32 lowercase hex>
LEAD_RADAR_INTEGRATION_ACCOUNT_REF=<new opaque reference, 16..160 URL-safe chars>
LEAD_RADAR_INTEGRATION_SENDER_FINGERPRINT=<SHA-256 of active decrypted session; server-side only>
LEAD_RADAR_INTEGRATION_TOKEN=<43..128 base64url characters; dedicated new secret>
LEAD_RADAR_PUBLIC_BUSINESS_INQUIRY_ENABLED=false
LEAD_RADAR_INBOX_ENABLED=false
LEAD_RADAR_OUTREACH_INBOX_TOKEN=<43 base64url characters; separate callback secret>
```

Existing requirements remain: `LIVE_SEND_ENABLED=true` for actual sends/resolution, encrypted active Telegram session, `ENCRYPTION_KEY`, Telegram API ID/hash, and database connectivity. Existing legacy campaigns are not automatically stopped: readiness reports `legacy_campaign_active`. New legacy campaign ingress for exactly the claimed mtproto owner rejects `LEAD_RADAR_SENDER_OWNED`; bot and other owners are unchanged. Disabling the integration releases future scheduling ownership but does not erase effect history or make unknown messages retryable.

`public_business_inquiry` is distinct from consent. The upstream authenticated LR boundary attests fresh official company evidence and exact owner-approved selection/content. Wire proof requires policy_version `public-business-inquiry-v1`, source_url_digest, approval_id (`lrtgap_`), selection_digest, content_digest, recipient_id (`lrtgcr_`), and first_contact_only:true. A separate TG gate, scoped peer proof, DNC and cross-campaign first-contact history are still enforced. The sender never inserts an allowed=true contact permission from discovery. Public mode never automatically follows up.

## Replies and cancellation safety

`server/delivery/leadRadarInbox.ts` runs a bounded inbound-only tick from the existing Node worker or Cloudflare Cron when its separate gate is enabled. It reads at most 20 messages from one private peer with a confirmed accepted LR effect from the last seven days; the cursor starts at that outbound Telegram message ID. It never lists unrelated chats. It shares the same sender lock, credential pin and FloodWait controls.

Incoming messages are persisted with a cursor transaction in an encrypted callback outbox. Any incoming reply immediately creates local sticky suppression, before callback delivery, preventing repeated automation during a callback outage. Explicit short stop phrases become opt_out; other text is reply, without an AI guess. The callback is fixed to `https://gptbot.uz/api/internal/lead-radar-inbox`, redirects forbidden, body bounded, token separate. Only a valid `{id:lrinb_<hex32>,replayed:boolean,workflowState:"applied"}` HTTP 200 acknowledges delivery. Network loss retries the same event and exact payload; HTTP 409 is retained as conflict. Callback bodies expire after seven days; identity/digest ledger remains. Opt-out/read failures never trigger sends.

The polling budget is deliberately small: one peer per tick and two callback attempts, normal cursor interval 60 seconds. Large contact cohorts may require a measured increase in an explicit later rollout. No attachment content is imported into the inbox. Stale session bindings are not repointed automatically.

## LR client API

`TgSenderCampaignSender` takes `{service:{fetch},token,binding,enabled,now?,timeoutMs?}`. Its fixed internal origin is `https://tg-sender.internal`; the root composition must map that through its configured server-only HTTPS endpoint. It exports `status()/readiness()`, `probeSession()`, `resolveContact(username)`, `prepare(input)`, `effectKey(originalFrozenInput)`, `send(input)`, `receipt(key)`, `cancel(key)`.

`input.username` is the fresh opaque peerRef, not a public username. `input.randomId` is the LR effect ID, and becomes callback `outboundEffectId`. Authorization comes directly from the revalidated LR domain. Keep the returned effect key durable with the frozen input: reconciliation must never substitute a current edited authorization/text. `effectKey()` permits an expired original authorization for receipt reconstruction only; `prepare()/send()` still reject it. No method performs an automatic dispatch retry.

## Reviewable release sequence

1. Preserve both repositories' existing work. Review these isolated diffs; run targeted tests against an isolated schema and typecheck.
2. Back up the target database and apply additive `015_lead_radar_effects.sql` and `016_lead_radar_inbox.sql` via the existing migration runner. Do not alter or delete applied ledger rows to retry messages.
3. Deploy TG Sender with gates off; anonymously verify 401/503 and status scope after adding a dedicated token. Verify the actual running host/commit and migration state, not just a local build.
4. Root must finish LR mode/env/service binding and account rebind. Set the exact pinned values on both sides server-side. Never show session fingerprint or access hash in the browser.
5. Resolve a deliberately selected test company only after rollout authorization, verify masked account and fresh opaque proof. Complete an owner-controlled test send/receipt/cancel and callback replay/opt-out, inspect ledger and inbox, and only then enable owner-approved real campaigns.
6. For rollout stop, disable integration and inbox gates, pause the LR queue, preserve unknown/cancelled effects and suppressions. Inspect active legacy campaigns before releasing sender ownership; do not automatically resume them.

## Local evidence

All transport calls and callbacks in tests use synthetic injected fakes; PostgreSQL tests use random disposable schemas in the explicitly provided local database. They exercise actual advisory locks, transaction state, `pg_terminate_backend` during a simulated provider call, duplicate effect replay, encrypted peer TTL, same-owner legacy isolation, durable waits, scoped auth, inbound cursor/outbox, callback outage/replay and sticky suppression. No live Telegram lookup/send is performed by these tests. Release, rollback version, backup and migration evidence are recorded separately by the release helper.
