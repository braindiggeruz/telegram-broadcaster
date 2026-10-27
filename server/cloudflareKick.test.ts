import { describe, expect, it } from "vitest";
import { shouldKickDelivery } from "./cloudflareKick";

const success = { result: { data: { json: { started: true } } } };
const failure = { error: { json: { code: -32001 } } };

function request(path: string, method = "POST") {
  return new Request(`https://sender.example/api/trpc/${path}`, { method });
}

describe("Cloudflare launch wakeup boundary", () => {
  it.each(["broadcast.launch", "mtproto.launchBroadcast"])(
    "wakes a committed authenticated %s launch",
    async path => {
      expect(
        await shouldKickDelivery(request(path), Response.json(success))
      ).toBe(true);
    }
  );

  it("handles the browser's batched single launch", async () => {
    expect(
      await shouldKickDelivery(
        request("mtproto.launchBroadcast?batch=1"),
        Response.json([success])
      )
    ).toBe(true);
  });

  it("correlates each successful result with the exact procedure in a mixed batch", async () => {
    const batch = request("broadcast.getProgress,mtproto.launchBroadcast?batch=1");
    expect(
      await shouldKickDelivery(batch, Response.json([failure, success], { status: 207 }))
    ).toBe(true);
    expect(
      await shouldKickDelivery(batch, Response.json([success, failure], { status: 207 }))
    ).toBe(false);
  });

  it.each(["auth.login", "broadcast.create", "mtproto.createBroadcast", "broadcast.launch.extra"])(
    "does not wake from an unrelated %s result",
    async path => {
      expect(
        await shouldKickDelivery(request(path), Response.json(success))
      ).toBe(false);
    }
  );

  it("rejects GET, failed auth/schema responses and uncommitted launches", async () => {
    expect(await shouldKickDelivery(request("broadcast.launch", "GET"), Response.json(success))).toBe(false);
    expect(await shouldKickDelivery(request("broadcast.launch"), Response.json(failure, { status: 401 }))).toBe(false);
    expect(await shouldKickDelivery(request("broadcast.launch"), Response.json(failure))).toBe(false);
    expect(await shouldKickDelivery(request("broadcast.launch"), Response.json({ result: { data: { json: { started: false } } } }))).toBe(false);
  });

  it("fails closed on mismatched batches, invalid JSON and unsuccessful HTTP responses", async () => {
    expect(await shouldKickDelivery(request("broadcast.launch?batch=1"), Response.json(success))).toBe(false);
    expect(await shouldKickDelivery(request("broadcast.launch,auth.login?batch=1"), Response.json([success]))).toBe(false);
    expect(await shouldKickDelivery(request("broadcast.launch"), new Response("invalid"))).toBe(false);
    expect(await shouldKickDelivery(request("broadcast.launch"), Response.json(success, { status: 500 }))).toBe(false);
  });
});
