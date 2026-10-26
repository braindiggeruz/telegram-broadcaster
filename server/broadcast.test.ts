import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import * as db from "./db";
import { dashboard } from "./dashboard";
vi.mock("./dashboard", () => ({
  dashboard: vi
    .fn()
    .mockResolvedValue({
      totalBroadcasts: 0,
      totalMessagesSent: 0,
      overallSuccessRate: 0,
      recentBroadcasts: [],
    }),
}));

vi.mock("./db", () => ({
  getBotSettings: vi.fn().mockResolvedValue(null),
  upsertBotSettings: vi.fn(),
  getRecipientLists: vi.fn().mockResolvedValue([]),
  getRecipientList: vi.fn().mockResolvedValue(null),
  createRecipientList: vi.fn(),
  deleteRecipientList: vi.fn(),
  getBroadcasts: vi.fn().mockResolvedValue([]),
  getBroadcast: vi.fn().mockResolvedValue(null),
  getMtprotoBroadcasts: vi.fn().mockResolvedValue([]),
  getMtprotoBroadcast: vi.fn().mockResolvedValue(null),
  getMtprotoSession: vi.fn().mockResolvedValue(null),
  upsertMtprotoSession: vi.fn(),
  deleteMtprotoSession: vi.fn(),
  getDashboardStats: vi
    .fn()
    .mockResolvedValue({
      totalBroadcasts: 0,
      totalMessagesSent: 0,
      overallSuccessRate: 0,
      recentBroadcasts: [],
    }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("APP_ORIGIN", "https://sender.example");
});
afterEach(() => vi.unstubAllEnvs());

function createCtx(userId: number | null = 42): TrpcContext {
  return {
    user:
      userId === null
        ? null
        : {
            id: userId,
            openId: "configured-owner",
            email: null,
            name: "Owner",
            loginMethod: "password",
            role: "admin",
            createdAt: new Date(),
            lastSignedIn: new Date(),
          },
    req: {
      protocol: "https",
      headers: { origin: "https://sender.example" },
    } as TrpcContext["req"],
    res: { clearCookie: vi.fn() } as unknown as TrpcContext["res"],
  };
}

describe("authenticated application API", () => {
  it("rejects anonymous access before any application data query", async () => {
    const caller = appRouter.createCaller(createCtx(null));
    for (const action of [
      () => caller.broadcast.list(),
      () => caller.bot.get(),
      () => caller.mtproto.getSession(),
      () => caller.recipients.list(),
      () => caller.stats.dashboard(),
    ]) {
      await expect(action()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    }
    expect(db.getBroadcasts).not.toHaveBeenCalled();
    expect(db.getBotSettings).not.toHaveBeenCalled();
    expect(db.getRecipientLists).not.toHaveBeenCalled();
  });

  it("scopes list and detail queries to the authenticated owner", async () => {
    const caller = appRouter.createCaller(createCtx(79));
    expect(await caller.broadcast.list()).toEqual([]);
    expect(await caller.broadcast.get({ id: 991 })).toBeNull();
    expect(await caller.recipients.get({ id: 992 })).toBeNull();
    expect(db.getBroadcasts).toHaveBeenCalledWith(79);
    expect(db.getBroadcast).toHaveBeenCalledWith(991, 79);
    expect(db.getRecipientList).toHaveBeenCalledWith(992, 79);
  });

  it("uses explicit DTOs that do not expose bot tokens or MTProto sessions", async () => {
    vi.mocked(db.getBotSettings).mockResolvedValueOnce({
      id: 1,
      botToken: "PRIVATE_BOT_TOKEN",
      userId: 79,
      isValid: true,
      botName: "Example",
    } as any);
    vi.mocked(db.getMtprotoSession).mockResolvedValueOnce({
      id: 2,
      sessionString: "PRIVATE_SESSION",
      userId: 79,
      isActive: true,
    } as any);
    const caller = appRouter.createCaller(createCtx(79));
    const bot = await caller.bot.get();
    const session = await caller.mtproto.getSession();
    expect(bot).toMatchObject({ botName: "Example", configured: true });
    expect(bot).not.toHaveProperty("botToken");
    expect(session).not.toHaveProperty("sessionString");
    expect(JSON.stringify({ bot, session })).not.toContain("PRIVATE");
  });

  it("returns owner-scoped empty states without inventing activity", async () => {
    const caller = appRouter.createCaller(createCtx(79));
    expect(await caller.stats.dashboard()).toEqual({
      totalBroadcasts: 0,
      totalMessagesSent: 0,
      overallSuccessRate: 0,
      recentBroadcasts: [],
    });
    expect(dashboard).toHaveBeenCalledWith(79);
    expect(await caller.bot.get()).toBeNull();
    expect(await caller.recipients.list()).toEqual([]);
  });

  it("rejects mutation CSRF before deleting any list", async () => {
    const ctx = createCtx(79);
    ctx.req.headers.origin = "https://other.example";
    await expect(
      appRouter.createCaller(ctx).recipients.delete({ id: 1 })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(db.deleteRecipientList).not.toHaveBeenCalled();
  });
});
