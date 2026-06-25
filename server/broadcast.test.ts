// Tests run in standalone mode — DB calls are mocked to avoid network dependency.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

// Mock the DB module so tests don't need a real Supabase connection
vi.mock("./db", () => ({
  getDb: vi.fn().mockResolvedValue(null),
  getBotSettings: vi.fn().mockResolvedValue(null),
  upsertBotSettings: vi.fn().mockResolvedValue(undefined),
  getRecipientLists: vi.fn().mockResolvedValue([]),
  getRecipientList: vi.fn().mockResolvedValue(null),
  createRecipientList: vi.fn().mockResolvedValue({ id: 1 }),
  deleteRecipientList: vi.fn().mockResolvedValue(undefined),
  getBroadcasts: vi.fn().mockResolvedValue([]),
  getBroadcast: vi.fn().mockResolvedValue(null),
  createBroadcast: vi.fn().mockResolvedValue({ id: 1 }),
  updateBroadcastStatus: vi.fn().mockResolvedValue(undefined),
  updateBroadcastProgress: vi.fn().mockResolvedValue(undefined),
  getBroadcastLogs: vi.fn().mockResolvedValue([]),
  createBroadcastLog: vi.fn().mockResolvedValue(undefined),
  getDashboardStats: vi.fn().mockResolvedValue({
    totalBroadcasts: 0,
    totalMessagesSent: 0,
    overallSuccessRate: 0,
    recentBroadcasts: [],
  }),
  getMtprotoSession: vi.fn().mockResolvedValue(null),
  upsertMtprotoSession: vi.fn().mockResolvedValue(undefined),
  deleteMtprotoSession: vi.fn().mockResolvedValue(undefined),
  getMtprotoBroadcasts: vi.fn().mockResolvedValue([]),
  getMtprotoBroadcast: vi.fn().mockResolvedValue(null),
  createMtprotoBroadcast: vi.fn().mockResolvedValue({ id: 1 }),
  updateMtprotoBroadcastStatus: vi.fn().mockResolvedValue(undefined),
  updateMtprotoBroadcastProgress: vi.fn().mockResolvedValue(undefined),
  createMtprotoBroadcastLog: vi.fn().mockResolvedValue(undefined),
  getMtprotoBroadcastLogs: vi.fn().mockResolvedValue([]),
  upsertUser: vi.fn().mockResolvedValue(undefined),
  getUserByOpenId: vi.fn().mockResolvedValue(null),
  getUserById: vi.fn().mockResolvedValue(null),
}));

function createCtx(userId = 1): TrpcContext {
  return {
    user: {
      id: userId,
      openId: "standalone",
      email: null,
      name: "Admin",
      loginMethod: null,
      role: "admin" as const,
      createdAt: new Date(),
      lastSignedIn: new Date(),
    },
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: vi.fn() } as unknown as TrpcContext["res"],
  };
}

describe("auth.logout", () => {
  it("returns success in standalone mode", async () => {
    const ctx = createCtx();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.auth.logout();
    expect(result.success).toBe(true);
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
