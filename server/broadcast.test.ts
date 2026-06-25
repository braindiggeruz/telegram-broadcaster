import { describe, expect, it, vi } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

function createCtx(userId = 1): TrpcContext {
  return {
    user: {
      id: userId,
      openId: "test-user",
      email: "test@example.com",
      name: "Test User",
      loginMethod: "manus",
      role: "user",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    },
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: vi.fn() } as unknown as TrpcContext["res"],
  };
}

describe("auth.logout", () => {
  it("clears the session cookie and reports success", async () => {
    const clearedCookies: { name: string; options: Record<string, unknown> }[] = [];
    const ctx: TrpcContext = {
      ...createCtx(),
      res: {
        clearCookie: (name: string, options: Record<string, unknown>) => {
          clearedCookies.push({ name, options });
        },
      } as unknown as TrpcContext["res"],
    };
    const caller = appRouter.createCaller(ctx);
    const result = await caller.auth.logout();
    expect(result.success).toBe(true);
    expect(clearedCookies).toHaveLength(1);
  });
});

describe("broadcast router", () => {
  it("returns empty list when no broadcasts exist", async () => {
    const ctx = createCtx(999999);
    const caller = appRouter.createCaller(ctx);
    const result = await caller.broadcast.list();
    expect(Array.isArray(result)).toBe(true);
  });

  it("returns null for non-existent broadcast", async () => {
    const ctx = createCtx(999999);
    const caller = appRouter.createCaller(ctx);
    const result = await caller.broadcast.get({ id: 999999 });
    expect(result).toBeNull();
  });
});

describe("stats router", () => {
  it("returns dashboard stats with correct shape", async () => {
    const ctx = createCtx(999999);
    const caller = appRouter.createCaller(ctx);
    const stats = await caller.stats.dashboard();
    expect(stats).toHaveProperty("totalBroadcasts");
    expect(stats).toHaveProperty("totalMessagesSent");
    expect(stats).toHaveProperty("overallSuccessRate");
    expect(stats).toHaveProperty("recentBroadcasts");
    expect(typeof stats.totalBroadcasts).toBe("number");
    expect(typeof stats.overallSuccessRate).toBe("number");
    expect(Array.isArray(stats.recentBroadcasts)).toBe(true);
  });
});

describe("bot router", () => {
  it("returns null when no bot settings configured", async () => {
    const ctx = createCtx(999999);
    const caller = appRouter.createCaller(ctx);
    const result = await caller.bot.get();
    expect(result).toBeNull();
  });
});

describe("recipients router", () => {
  it("returns empty list when no recipient lists exist", async () => {
    const ctx = createCtx(999999);
    const caller = appRouter.createCaller(ctx);
    const result = await caller.recipients.list();
    expect(Array.isArray(result)).toBe(true);
  });
});
