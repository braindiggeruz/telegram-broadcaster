import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authRouter } from "./auth";
import type { TrpcContext } from "./_core/context";

beforeEach(() => vi.stubEnv("APP_ORIGIN", "https://sender.example"));
afterEach(() => vi.unstubAllEnvs());

function createCtx(): TrpcContext {
  return {
    user: null,
    req: {
      protocol: "https",
      headers: { origin: "https://sender.example" },
    } as TrpcContext["req"],
    res: { clearCookie: vi.fn() } as unknown as TrpcContext["res"],
  };
}

describe("logout boundary", () => {
  it("is idempotent for logged-out callers and clears the browser cookie", async () => {
    const ctx = createCtx();
    expect(await authRouter.createCaller(ctx).logout()).toEqual({
      success: true,
    });
    expect(ctx.res.clearCookie).toHaveBeenCalledWith("app_session_id", {
      httpOnly: true,
      path: "/",
      sameSite: "strict",
      secure: true,
    });
  });

  it("rejects a cross-origin logout without clearing the session", async () => {
    const ctx = createCtx();
    ctx.req.headers.origin = "https://other.example";
    await expect(authRouter.createCaller(ctx).logout()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(ctx.res.clearCookie).not.toHaveBeenCalled();
  });
});
