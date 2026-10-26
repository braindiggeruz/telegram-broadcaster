import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";
import { assertSameOrigin } from "../security/origin";
import { redactText } from "../security/redaction";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      message:
        error.code === "INTERNAL_SERVER_ERROR"
          ? "Внутренняя ошибка. Проверьте состояние сервиса."
          : redactText(shape.message),
      data: { ...shape.data, stack: undefined },
    };
  },
});
export const router = t.router;
export const publicProcedure = t.procedure.use(({ ctx, type, next }) => {
  if (type === "mutation") assertSameOrigin(ctx.req);
  return next();
});
export const protectedProcedure = publicProcedure.use(({ ctx, next }) => {
  if (!ctx.user)
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Please login (10001)",
    });
  return next({ ctx: { ...ctx, user: ctx.user } });
});
export const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "admin")
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Administrator access required",
    });
  return next({ ctx });
});
