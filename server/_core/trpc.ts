// Standalone mode: no authentication middleware needed.
// protectedProcedure and adminProcedure are aliases for publicProcedure
// because context.ts always provides a fixed standalone user.

import { initTRPC } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;
export const protectedProcedure = t.procedure;
export const adminProcedure = t.procedure;
