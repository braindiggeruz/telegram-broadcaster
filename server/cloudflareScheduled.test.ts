import { describe, expect, it, vi } from "vitest";

vi.mock("./connection", () => ({
  getPool: vi.fn(),
  runWithDatabaseScope: vi.fn(),
}));
vi.mock("./automation", () => ({ tickAutomations: vi.fn() }));
vi.mock("./delivery", () => ({
  recordWorkerHeartbeat: vi.fn(),
  recordWorkerSuccess: vi.fn(),
  runWorkerOnce: vi.fn(),
}));
vi.mock("./telegramTransport", () => ({ telegramTransport: {} }));

import { runBoundedDeliveryBatch } from "./cloudflareScheduled";

describe("bounded cloud delivery batch", () => {
  it("exits an idle queue without keeping a Worker alive", async () => {
    const dispatch = vi.fn(async () => ({ worked: false }));
    const sleep = vi.fn();
    expect(
      await runBoundedDeliveryBatch({
        dispatch,
        nextDelay: async () => null,
        heartbeat: vi.fn(),
        deadline: 1000,
        now: () => 0,
        sleep,
      })
    ).toEqual({ completed: 0 });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not wait for a distant schedule", async () => {
    const sleep = vi.fn();
    await runBoundedDeliveryBatch({
      dispatch: async () => ({ worked: false }),
      nextDelay: async () => 60_000,
      heartbeat: vi.fn(),
      deadline: 40_000,
      now: () => 0,
      sleep,
    });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("honors a short sender wait and persists successful bounded work", async () => {
    let now = 0;
    const dispatch = vi
      .fn()
      .mockResolvedValueOnce({ worked: false })
      .mockResolvedValue({ worked: true });
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });
    const result = await runBoundedDeliveryBatch({
      dispatch,
      nextDelay: async () => 3000,
      heartbeat: vi.fn(),
      deadline: 40_000,
      maxDeliveries: 2,
      now: () => now,
      sleep,
    });
    expect(result.completed).toBe(2);
    expect(sleep).toHaveBeenCalledWith(3000);
    expect(dispatch).toHaveBeenCalledTimes(3);
  });

  it("lets an active attempt settle, then refuses another past the deadline", async () => {
    let now = 0;
    const dispatch = vi.fn(async () => {
      now = 45_000;
      return { worked: true };
    });
    const heartbeat = vi.fn();
    expect(
      (
        await runBoundedDeliveryBatch({
          dispatch,
          nextDelay: vi.fn(),
          heartbeat,
          deadline: 40_000,
          now: () => now,
        })
      ).completed
    ).toBe(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(heartbeat).toHaveBeenCalledTimes(1);
  });

  it("does not retry an error whose dispatch result might be unknown", async () => {
    const dispatch = vi.fn(async () => {
      throw new Error("uncertain");
    });
    await expect(
      runBoundedDeliveryBatch({
        dispatch,
        nextDelay: vi.fn(),
        heartbeat: vi.fn(),
        deadline: 40_000,
        now: () => 0,
      })
    ).rejects.toThrow("uncertain");
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("does not spin when another invocation holds the sender lock", async () => {
    let now = 0;
    const dispatch = vi.fn(async () => ({ worked: false }));
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });
    await runBoundedDeliveryBatch({
      dispatch,
      nextDelay: async () => 0,
      heartbeat: vi.fn(),
      deadline: 2100,
      now: () => now,
      sleep,
    });
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
