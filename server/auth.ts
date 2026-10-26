import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { COOKIE_NAME } from "../shared/const";
import { router, publicProcedure } from "./_core/trpc";
import { getSessionCookieOptions } from "./_core/cookies";
import { verifyOwnerPassword } from "./security/password";
import {
  clearLoginAttempts,
  consumeLoginAttempt,
  createOwnerSession,
  revokeRequestSession,
  SESSION_TTL_MS,
} from "./security/sessions";

export const authRouter = router({
  me: publicProcedure.query(({ ctx }) => ctx.user),
  login: publicProcedure
    .input(z.object({ password: z.string().min(1).max(1024) }))
    .mutation(async ({ ctx, input }) => {
      const ip = ctx.req.ip || ctx.req.socket?.remoteAddress || "unknown";
      if (!(await consumeLoginAttempt(ip)))
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "Слишком много попыток. Повторите через 15 минут.",
        });
      if (
        !(await verifyOwnerPassword(
          input.password,
          process.env.OWNER_PASSWORD_HASH ?? ""
        ))
      ) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Неверный пароль",
        });
      }
      await revokeRequestSession(ctx.req);
      const { user, token } = await createOwnerSession();
      await clearLoginAttempts(ip);
      ctx.res.cookie(COOKIE_NAME, token, {
        ...getSessionCookieOptions(ctx.req),
        maxAge: SESSION_TTL_MS,
      });
      return { success: true as const, user };
    }),
  logout: publicProcedure.mutation(async ({ ctx }) => {
    await revokeRequestSession(ctx.req);
    ctx.res.clearCookie(COOKIE_NAME, getSessionCookieOptions(ctx.req));
    return { success: true as const };
  }),
});
