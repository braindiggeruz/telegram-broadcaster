import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "./_core/trpc";
import { getPool } from "./connection";
import { getPhotoMetadata, requirePhotoMetadata } from "./media";
import { PHOTO_CAPTION_MAX_LENGTH } from "../shared/media";
const key = z.enum(["bot", "mtproto"]);
const mode = z.enum(["HTML", "Markdown", "MarkdownV2", "None"]);
const dto = async (ownerId: number, r: any) =>
  r
    ? {
        key: r.key,
        message: r.message,
        parseMode: r.parse_mode,
        photoId: r.photo_id ?? null,
        photo: r.photo_id ? await getPhotoMetadata(ownerId, r.photo_id) : null,
        version: r.version,
        updatedAt: r.updated_at,
      }
    : null;
export const draftRouter = router({
  get: protectedProcedure
    .input(z.object({ key }))
    .query(async ({ ctx, input }) =>
      dto(
        ctx.user.id,
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
        photoId: z.string().uuid().nullable().optional().default(null),
        expectedVersion: z.number().int().nonnegative().default(0),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (input.photoId) {
        if (input.key !== "mtproto")
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Фото доступно для рассылки от аккаунта",
          });
        if (input.message.length > PHOTO_CAPTION_MAX_LENGTH)
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Подпись к фото — до 1024 символов, включая разметку",
          });
        await requirePhotoMetadata(ctx.user.id, input.photoId);
      }
      const result = await getPool().query(
        `INSERT INTO message_drafts(owner_id,key,message,parse_mode,version,photo_id) SELECT $1,$2,$3,$4,1,$6 WHERE $5=0
      ON CONFLICT(owner_id,key) DO UPDATE SET message=excluded.message,parse_mode=excluded.parse_mode,photo_id=excluded.photo_id,version=message_drafts.version+1,updated_at=now() WHERE message_drafts.version=$5 RETURNING *`,
        [
          ctx.user.id,
          input.key,
          input.message,
          input.parseMode,
          input.expectedVersion,
          input.photoId,
        ]
      );
      if (result.rowCount) return (await dto(ctx.user.id, result.rows[0]))!;
      // Existing rows need an UPDATE when the expected version is nonzero.
      const update = await getPool().query(
        "UPDATE message_drafts SET message=$3,parse_mode=$4,photo_id=$6,version=version+1,updated_at=now() WHERE owner_id=$1 AND key=$2 AND version=$5 RETURNING *",
        [
          ctx.user.id,
          input.key,
          input.message,
          input.parseMode,
          input.expectedVersion,
          input.photoId,
        ]
      );
      if (!update.rowCount)
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "Черновик изменён в другом окне. Сохраните свой текст и обновите страницу.",
        });
      return (await dto(ctx.user.id, update.rows[0]))!;
    }),
});
