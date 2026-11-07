import express from "express";
import { type AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerLeadRadarIntegration } from "./leadRadarIntegration";
import {
  LR_PREFIX,
  LR_SCHEMA,
  commandDigest,
  integrationConfig,
  leadRadarOwnsSender,
  classifyIntegrationFailure,
  LrIntegrationError,
  type LrConfig,
  type LeadRadarEffects,
} from "./delivery/leadRadarEffects";
import { DeliveryError } from "./delivery/types";
import { assertLegacyCampaignSender } from "./campaigns";
const config: LrConfig = {
  ownerId: 77001,
  token: "t".repeat(48),
  minIntervalSeconds: 120,
  contactIntervalSeconds: 86400,
  publicInquiryEnabled: false,
  binding: {
    org_id: "test-org",
    account_id: `lrtgua_${"a".repeat(32)}`,
    account_ref: "test_gateway_ref_0001",
    sender_fingerprint: "b".repeat(64),
  },
};
afterEach(() => vi.unstubAllEnvs());
async function withServer(
  run: (url: string) => Promise<void>,
  options: Parameters<typeof registerLeadRadarIntegration>[1]
) {
  const app = express();
  app.use(express.json());
  registerLeadRadarIntegration(app, options);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  try {
    await run(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}${LR_PREFIX}`
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close(e => (e ? reject(e) : resolve()))
    );
  }
}
describe("private Lead Radar integration protocol", () => {
  it("has an independently computed stable canonical hash", () => {
    const draft = {
      schema: LR_SCHEMA,
      binding: config.binding,
      effect_id: "effect_0001",
      recipient: `lrpeer:${"c".repeat(32)}`,
      text: "Synthetic question",
      authorization: {
        basis: "documented_consent" as const,
        reference: "authorization_01",
        expires_at: "2030-01-01T00:00:00.000Z",
      },
      paid_message_policy: "reject" as const,
      allow_paid_floodskip: false as const,
      parse_mode: "None" as const,
    };
    expect(commandDigest(draft)).toBe(
      "636f1c9af0d8d25bf12883d53469dc020e44a8994172c733eb33ba96709c9dcf"
    );
  });
  it("default disables, pins exact sender and isolates legacy owner/bot behavior", () => {
    expect(integrationConfig({})).toBeNull();
    const env = {
      LEAD_RADAR_INTEGRATION_ENABLED: "true",
      LEAD_RADAR_INTEGRATION_OWNER_ID: "77001",
    };
    expect(integrationConfig(env)).toBeNull();
    expect(leadRadarOwnsSender(77001, "mtproto", env)).toBe(true);
    expect(leadRadarOwnsSender(77002, "mtproto", env)).toBe(false);
    expect(leadRadarOwnsSender(77001, "bot", env)).toBe(false);
    vi.stubEnv("LEAD_RADAR_INTEGRATION_ENABLED", "true");
    vi.stubEnv("LEAD_RADAR_INTEGRATION_OWNER_ID", "77001");
    expect(() => assertLegacyCampaignSender(77001, "mtproto")).toThrow(
      "Lead Radar"
    );
    expect(() => assertLegacyCampaignSender(77001, "bot")).not.toThrow();
  });
  it("only typed confirmed rejection maps rejected; invalid waits become unknown", () => {
    expect(classifyIntegrationFailure(new Error("timeout"))).toEqual({
      state: "unknown",
    });
    expect(
      classifyIntegrationFailure(
        new DeliveryError("cooldown", "FLOOD_WAIT", Infinity)
      )
    ).toEqual({ state: "unknown" });
    expect(
      classifyIntegrationFailure(
        new DeliveryError("cooldown", "FLOOD_WAIT", 400)
      )
    ).toEqual({
      state: "rejected",
      code: "flood_wait",
      retry_after_seconds: 400,
    });
  });
  it("denies disabled, anonymous, cookie-only, incorrect token and browser Origin before service access", async () => {
    const effects = vi.fn(() => {
      throw new Error("must not run");
    });
    await withServer(
      async url => {
        expect((await fetch(url + "/status")).status).toBe(503);
      },
      { config: () => null, effects }
    );
    await withServer(
      async url => {
        for (const headers of [
          {},
          { Cookie: "owner=session" },
          { Authorization: "Bearer wrong" },
          {
            Authorization: `Bearer ${config.token}`,
            Origin: "https://gptbot.uz",
          },
        ])
          expect((await fetch(url + "/status", { headers })).status).toBe(401);
      },
      { config: () => config, effects }
    );
    expect(effects).not.toHaveBeenCalled();
  });
  it("validates scoped resolve/dispatch inputs and maps failures without raw exception data", async () => {
    const resolve = vi
      .fn()
      .mockResolvedValue({ status: "blocked", reason_code: "sender_cooldown" });
    const dispatch = vi
      .fn()
      .mockRejectedValue(new LrIntegrationError("PAYLOAD_CONFLICT"));
    const effects = () =>
      ({
        resolve,
        dispatch,
        status: async () => ({ ready: true }),
      }) as unknown as LeadRadarEffects;
    await withServer(
      async url => {
        const headers = {
          Authorization: `Bearer ${config.token}`,
          "Content-Type": "application/json",
        };
        const status = await fetch(url + "/status", { headers });
        expect(status.status).toBe(200);
        expect(status.headers.get("cache-control")).toBe("no-store");
        expect(
          (
            await fetch(url + "/contacts/resolve", {
              method: "POST",
              headers,
              body: JSON.stringify({
                schema: LR_SCHEMA,
                binding: config.binding,
                username: "testcompany",
                access_hash: "raw",
              }),
            })
          ).status
        ).toBe(400);
        expect(
          (
            await fetch(url + "/contacts/resolve", {
              method: "POST",
              headers,
              body: JSON.stringify({
                schema: LR_SCHEMA,
                binding: config.binding,
                username: "testcompany",
              }),
            })
          ).status
        ).toBe(200);
        expect(resolve).toHaveBeenCalledOnce();
        expect(
          (
            await fetch(url + "/effects", {
              method: "POST",
              headers,
              body: JSON.stringify({ effect_id: "effect_0001" }),
            })
          ).status
        ).toBe(400);
        expect(dispatch).not.toHaveBeenCalled();
        expect(
          (
            await fetch(url + "/effects", {
              method: "POST",
              headers: { ...headers, "Idempotency-Key": "effect_0001" },
              body: JSON.stringify({ effect_id: "effect_0001" }),
            })
          ).status
        ).toBe(409);
      },
      { config: () => config, effects }
    );
    await withServer(
      async url => {
        const result = await fetch(url + "/status", {
          headers: { Authorization: `Bearer ${config.token}` },
        });
        expect(result.status).toBe(503);
        expect(await result.text()).not.toContain("secret detail");
      },
      {
        config: () => config,
        effects: () => {
          throw new Error("secret detail");
        },
      }
    );
  });
});
