import { createHmac, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import * as db from "./db";
import { closePool, databasePoolConfig, getPool } from "./connection";
import { senderKey } from "./delivery/types";
import { registerTelegramWebhook } from "./telegramWebhook";

const url = process.env.TEST_DATABASE_URL;

// Local PostgreSQL and HTTP only: every credential and event is synthetic.
describe.skipIf(!url)(
  "Telegram subscription credential races on PostgreSQL",
  () => {
    const schema = `webhook_test_${randomUUID().replaceAll("-", "")}`;
    const ownerId = 97001;
    const initialToken = "12345678:synthetic_original_webhook_token";
    const hmacKey = "synthetic-webhook-hmac-key-at-least-32-characters";
    let admin: Pool, pool: Pool, server: Server, origin: string;

    beforeAll(async () => {
      admin = new Pool(
        databasePoolConfig({
          ...process.env,
          DATABASE_URL: url,
          DATABASE_SSL: "disable",
        })
      );
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const isolated = new URL(url!);
      isolated.searchParams.set("options", `-c search_path=${schema}`);
      isolated.searchParams.set("application_name", schema);
      vi.stubEnv("DATABASE_URL", isolated.toString());
      vi.stubEnv("DATABASE_SSL", "disable");
      vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 41).toString("base64"));
      vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", hmacKey);
      pool = getPool();
      await pool.query(
        "CREATE TABLE app_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())"
      );
      await pool.query(
        (await readFile("drizzle/0000_massive_chamber.sql", "utf8")).replaceAll(
          '"public".',
          `"${schema}".`
        )
      );
      for (const file of (await readdir("migrations"))
        .filter(file => file.endsWith(".sql"))
        .sort()) {
        await pool.query(await readFile(`migrations/${file}`, "utf8"));
      }
      const app = express();
      app.use(express.json({ limit: "128kb" }));
      registerTelegramWebhook(app);
      server = await new Promise<Server>(resolve => {
        const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
      });
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    }, 30000);

    beforeEach(async () => {
      vi.restoreAllMocks();
      await pool.query(
        "TRUNCATE bot_settings,contact_permissions,telegram_subscription_cursors,audit_events RESTART IDENTITY CASCADE"
      );
      await db.upsertBotSettings(ownerId, {
        botToken: initialToken,
        botUsername: "original_test_bot",
        isValid: true,
      });
    });

    afterAll(async () => {
      vi.restoreAllMocks();
      if (server)
        await new Promise<void>((resolve, reject) =>
          server.close(error => (error ? reject(error) : resolve()))
        );
      await closePool();
      if (admin) {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await admin.end();
      }
      vi.unstubAllEnvs();
    });

    async function subscribe(token = initialToken, text = "/subscribe") {
      const secret = createHmac("sha256", hmacKey)
        .update(`${ownerId}:${token}`)
        .digest("hex");
      return fetch(`${origin}/api/telegram/${ownerId}/updates`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Telegram-Bot-Api-Secret-Token": secret,
        },
        body: JSON.stringify({
          update_id: 1,
          message: {
            date: Math.floor(Date.now() / 1000),
            text,
            chat: { id: 101, type: "private" },
          },
        }),
      });
    }

    async function expectNoSubscription() {
      expect(
        (
          await pool.query(
            "SELECT 1 FROM contact_permissions WHERE owner_id=$1",
            [ownerId]
          )
        ).rowCount
      ).toBe(0);
      expect(
        (
          await pool.query(
            "SELECT 1 FROM telegram_subscription_cursors WHERE owner_id=$1",
            [ownerId]
          )
        ).rowCount
      ).toBe(0);
      expect(
        (
          await pool.query(
            "SELECT 1 FROM audit_events WHERE owner_id=$1 AND action='contact.subscribed'",
            [ownerId]
          )
        ).rowCount
      ).toBe(0);
    }

    it.each([
      ["a different bot", "87654321:synthetic_replacement_webhook_token"],
      [
        "a rotated key for the same bot",
        "12345678:synthetic_rotated_webhook_token",
      ],
    ])(
      "rejects an update authenticated before switching to %s",
      async (_description, replacementToken) => {
        const readSettings = db.getBotSettings;
        const readSpy = vi
          .spyOn(db, "getBotSettings")
          .mockImplementationOnce(async owner => {
            const previouslyAuthenticatedSettings = await readSettings(owner);
            // This runs before the handler begins its transaction, avoiding a nested
            // sender lock while exercising the real atomic replacement implementation.
            await db.upsertBotSettings(owner, {
              botToken: replacementToken,
              botUsername: "current_test_bot",
              isValid: true,
            });
            return previouslyAuthenticatedSettings;
          });
        const response = await subscribe();
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: "UNAUTHORIZED" });
        expect(readSpy).toHaveBeenCalledTimes(2);
        await expectNoSubscription();
        readSpy.mockRestore();
        // The rejection is specific to the stale secret, not a broken endpoint.
        expect((await subscribe(replacementToken)).status).toBe(200);
        expect(
          (
            await pool.query(
              "SELECT allowed FROM contact_permissions WHERE owner_id=$1",
              [ownerId]
            )
          ).rows
        ).toEqual([{ allowed: true }]);
        expect(
          (
            await pool.query(
              "SELECT 1 FROM telegram_subscription_cursors WHERE owner_id=$1",
              [ownerId]
            )
          ).rowCount
        ).toBe(1);
      }
    );

    it("rechecks the addressed bot username after acquiring the sender lock", async () => {
      const readSettings = db.getBotSettings;
      vi.spyOn(db, "getBotSettings").mockImplementationOnce(async owner => {
        const original = await readSettings(owner);
        await db.upsertBotSettings(owner, {
          botToken: initialToken,
          botUsername: "renamed_test_bot",
          isValid: true,
        });
        return original;
      });
      expect(
        (await subscribe(initialToken, "/subscribe@original_test_bot")).status
      ).toBe(200);
      await expectNoSubscription();
    });

    it("uses exactly the worker and credential-replacement sender lock before its second read", async () => {
      const worker = await pool.connect();
      const workerLockKey = `tg-sender:${senderKey(ownerId, "bot")}`;
      const readSpy = vi.spyOn(db, "getBotSettings");
      let request: Promise<Response> | undefined;
      try {
        await worker.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [
          workerLockKey,
        ]);
        request = subscribe();
        let waiting = false;
        for (let attempt = 0; attempt < 200; attempt++) {
          waiting =
            (
              await pool.query(
                "SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event='advisory' LIMIT 1",
                [schema]
              )
            ).rowCount! > 0;
          if (waiting) break;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(waiting).toBe(true);
        expect(readSpy).toHaveBeenCalledTimes(1);
        await expectNoSubscription();
      } finally {
        await worker.query(
          "SELECT pg_advisory_unlock(hashtextextended($1,0))",
          [workerLockKey]
        );
        worker.release();
      }
      expect((await request!).status).toBe(200);
      expect(readSpy).toHaveBeenCalledTimes(2);
      expect(
        (
          await pool.query(
            "SELECT allowed FROM contact_permissions WHERE owner_id=$1",
            [ownerId]
          )
        ).rows
      ).toEqual([{ allowed: true }]);
    });
  }
);
