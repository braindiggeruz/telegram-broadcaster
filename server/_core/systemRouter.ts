import { z } from "zod";
import { router, publicProcedure } from "./trpc";
import { readiness } from "../operations";
export const systemRouter = router({
  health: publicProcedure
    .input(z.object({ timestamp: z.number().nonnegative() }).optional())
    .query(async () => ({ ok: (await readiness()).ready })),
});
