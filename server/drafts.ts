import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "./_core/trpc";
import { getPool } from "./connection";
const key = z.enum(["bot", "mtproto"]);
const mode = z.enum(["HTML", "Markdown", "MarkdownV2", "None"]);
const dto = (r: any) =>
  r
    ? {
        key: r.key,
        message: r.message,
        parseMode: r.parse_mode,
        version: r.version,
        updatedAt: r.updated_at,
      }
    : null;
export const draftRouter = router({
  get: protectedProcedure
    .input(z.object({ key }))
    .query(async ({ ctx, input }) =>
      dto(
        (
          await getPool().query(
            "SELECT * FROM message_drafts WHERE owner_id=$1 AND key=$2",
            [ctx.user.id, input.key]
          )
        ).rows[0]
      )
    ),
  save: protectedProcedure
    .input(
      z.object({
        key,
        message: z.string().max(4096),
        parseMode: mode,
        expectedVersion: z.number().int().nonnegative().default(0),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const result = await getPool().query(
        `INSERT INTO message_drafts(owner_id,key,message,parse_mode,version) SELECT $1,$2,$3,$4,1 WHERE $5=0
      ON CONFLICT(owner_id,key) DO UPDATE SET message=excluded.message,parse_mode=excluded.parse_mode,version=message_drafts.version+1,updated_at=now() WHERE message_drafts.version=$5 RETURNING *`,
        [
          ctx.user.id,
          input.key,
          input.message,
          input.parseMode,
          input.expectedVersion,
        ]
      );
      if (result.rowCount) return dto(result.rows[0])!;
      // Existing rows need an UPDATE when the expected version is nonzero.
      const update = await getPool().query(
        "UPDATE message_drafts SET message=$3,parse_mode=$4,version=version+1,updated_at=now() WHERE owner_id=$1 AND key=$2 AND version=$5 RETURNING *",
        [
          ctx.user.id,
          input.key,
          input.message,
          input.parseMode,
          input.expectedVersion,
        ]
      );
      if (!update.rowCount)
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "Черновик изменён в другом окне. Сохраните свой текст и обновите страницу.",
        });
      return dto(update.rows[0])!;
    }),
});
