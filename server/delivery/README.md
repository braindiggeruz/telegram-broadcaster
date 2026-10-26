# Durable delivery engine

Apply `migrations/003-delivery.sql` through the application migration runner. `server/worker.ts` is a separate process from the web application. It uses the same PostgreSQL connection settings and defaults to `LIVE_SEND_ENABLED=false`.

`enqueueCampaign` snapshots message, parse mode, typed recipients, schedule, expiry, pacing and dry-run mode. `(owner_id, kind, broadcast_id)` is the idempotency key: an identical enqueue returns the existing campaign; changing the approved snapshot under that key fails. Create a new broadcast/version for changed content.

Every worker takes a PostgreSQL session advisory lock for `owner_id:kind` and holds it until one transport call has settled. A campaign row lock serializes claims against cancellation. Cancellation is acknowledged only when active claims have settled; a request already dispatched can finish while the UI displays `stopping`. All workers share sender cooldowns and contact-frequency state.

After obtaining the sender lock, a worker recovers abandoned `inflight` deliveries as `unknown`. It never moves them back to pending. There is no exactly-once guarantee across Telegram and the local database: Bot API acceptance followed by response or database loss remains unknown. MTProto transports receive a persisted random_id per logical message.

Transport must honor AbortSignal and finish/abort its request before settling. Return `{messageId}` only for confirmed acceptance. Use `DeliveryError` only for a known rejection or a confirmed pre-dispatch failure; plain errors become unknown. Never place raw URLs, credentials or exception text in the structured error code. Paid broadcasting is not enabled by this engine.

At actual dispatch, check current explicit contact permission and sticky suppression; a reimport cannot undo opt-out. The same checks run in dry-run, which records `dry_run` or `suppressed` and never invokes transport. Raw numeric values always mean chat IDs. Use `phone:+...`, `chat:...`, or `username:...`; explicit `+phone`, signed numeric chat IDs and `@username` normalize to those forms.

`CONTACT_MIN_INTERVAL_SECONDS` defaults to 86400 across live campaigns for the same sender/recipient. Mandatory server waits cannot be shortened by manual sender resume. Campaign expiry and cancellation continue processing even when live sending is disabled or the sender is paused.

Tests: `pnpm exec vitest run server/delivery`. PostgreSQL integration tests run only with `TEST_DATABASE_URL`; each run creates and later drops a random isolated schema and never touches application tables. Test transports are fake and no Telegram messages are sent.
