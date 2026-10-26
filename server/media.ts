import { createHash, randomUUID } from "node:crypto";
import type { Express } from "express";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "./_core/trpc";
import { getPool } from "./connection";
import { readAuthenticatedUser } from "./security/sessions";
import { encryptSecret, decryptSecret } from "./security/secrets";
import {
  PHOTO_MAX_BYTES,
  PHOTO_OWNER_QUOTA_BYTES,
  type PhotoAttachment,
} from "../shared/media";

type Queryable = Pool | PoolClient;
const COLUMNS = "id,name,mime_type,size,width,height,sha256";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function invalid(message: string): never {
  throw new TRPCError({ code: "BAD_REQUEST", message });
}

/** Raster signatures and bounded dimensions; URLs, SVG and executable content are never accepted. */
export function validatePhoto(dataBase64: string, mimeType: string) {
  if (
    !dataBase64 ||
    dataBase64.length % 4 !== 0 ||
    dataBase64.length > 4 * Math.ceil(PHOTO_MAX_BYTES / 3)
  )
    invalid("Некорректный файл изображения. Выберите JPG или PNG до 1 МБ.");
  const bytes = Buffer.from(dataBase64, "base64");
  if (
    !bytes.length ||
    bytes.length > PHOTO_MAX_BYTES ||
    bytes.toString("base64") !== dataBase64
  )
    invalid("Изображение должно быть не больше 1 МБ после подготовки.");
  let width = 0,
    height = 0;
  if (
    mimeType === "image/png" &&
    bytes.length >= 45 &&
    bytes.subarray(0, 8).equals(PNG)
  ) {
    let offset = 8,
      first = true,
      imageData = false,
      ended = false;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      if (length > bytes.length - offset - 12)
        invalid("Повреждённое PNG-изображение.");
      const kind = bytes.toString("ascii", offset + 4, offset + 8);
      if (first) {
        if (kind !== "IHDR" || length !== 13)
          invalid("Повреждённое PNG-изображение.");
        width = bytes.readUInt32BE(offset + 8);
        height = bytes.readUInt32BE(offset + 12);
      } else if (kind === "IHDR") invalid("Повреждённое PNG-изображение.");
      if (kind === "IDAT") imageData = true;
      offset += length + 12;
      first = false;
      if (kind === "IEND") {
        ended = length === 0 && offset === bytes.length;
        break;
      }
    }
    if (!ended || !imageData) invalid("Повреждённое PNG-изображение.");
  } else if (
    mimeType === "image/jpeg" &&
    bytes.length >= 16 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[bytes.length - 2] === 255 &&
    bytes[bytes.length - 1] === 217
  ) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 218 || marker === 217 || marker === undefined) break;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if (marker === 192 || marker === 194) {
        if (length < 8) break;
        height = bytes.readUInt16BE(offset + 3);
        width = bytes.readUInt16BE(offset + 5);
        break;
      }
      offset += length;
    }
  }
  if (
    !width ||
    !height ||
    width > 4096 ||
    height > 4096 ||
    Math.max(width / height, height / width) > 20
  )
    invalid(
      "Не удалось прочитать изображение. Поддерживаются JPG и PNG до 4096 × 4096, без очень узких панорам."
    );
  return {
    bytes,
    width,
    height,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    mimeType: mimeType as PhotoAttachment["mimeType"],
  };
}

export function safePhotoName(
  name: string,
  mimeType: PhotoAttachment["mimeType"]
) {
  const base =
    name
      .split(/[\\/]/)
      .at(-1)!
      .normalize("NFC")
      .replace(/[\u0000-\u001f\u007f<>"\u202a-\u202e\u2066-\u2069]/g, "")
      .replace(/\.[^.]*$/, "")
      .trim()
      .slice(0, 100) || "photo";
  return base + (mimeType === "image/png" ? ".png" : ".jpg");
}

function dto(row: any): PhotoAttachment {
  return {
    id: row.id,
    name: row.name,
    mimeType: row.mime_type,
    size: row.size,
    width: row.width,
    height: row.height,
    sha256: row.sha256,
    url: `/api/media/${row.id}`,
  };
}
export async function getPhotoMetadata(
  ownerId: number,
  id: string,
  database: Queryable = getPool()
): Promise<PhotoAttachment | null> {
  if (!UUID.test(id)) return null;
  const result = await database.query(
    `SELECT ${COLUMNS} FROM message_media WHERE id=$1 AND owner_id=$2`,
    [id, ownerId]
  );
  return result.rows[0] ? dto(result.rows[0]) : null;
}
export async function requirePhotoMetadata(
  ownerId: number,
  id: string,
  database: Queryable = getPool()
) {
  const value = await getPhotoMetadata(ownerId, id, database);
  if (!value)
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Изображение не найдено. Прикрепите его ещё раз.",
    });
  return value;
}
export async function getPhotoBytes(
  ownerId: number,
  id: string,
  database: Queryable = getPool()
) {
  if (!UUID.test(id)) throw new Error("PHOTO_CONTENT_UNAVAILABLE");
  const result = await database.query(
    `SELECT ${COLUMNS},content_encrypted FROM message_media WHERE id=$1 AND owner_id=$2`,
    [id, ownerId]
  );
  const row = result.rows[0];
  if (!row) throw new Error("PHOTO_CONTENT_UNAVAILABLE");
  const encoded = decryptSecret(
    row.content_encrypted,
    `photo:${ownerId}:${id}`
  );
  const valid = validatePhoto(encoded, row.mime_type);
  if (
    valid.sha256 !== row.sha256 ||
    valid.bytes.length !== row.size ||
    valid.width !== row.width ||
    valid.height !== row.height
  )
    throw new Error("PHOTO_INTEGRITY_FAILED");
  return { attachment: dto(row), bytes: valid.bytes };
}

export async function storePhoto(
  ownerId: number,
  input: { name: string; mimeType: string; dataBase64: string }
): Promise<PhotoAttachment> {
  const photo = validatePhoto(input.dataBase64, input.mimeType);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `photo-upload:${ownerId}`,
    ]);
    const prior = await client.query(
      `SELECT ${COLUMNS} FROM message_media WHERE owner_id=$1 AND sha256=$2`,
      [ownerId, photo.sha256]
    );
    if (prior.rows[0]) {
      await client.query("COMMIT");
      return dto(prior.rows[0]);
    }
    // Only abandoned uploads expire. Drafts and immutable campaigns retain their exact image.
    await client.query(
      `DELETE FROM message_media m WHERE owner_id=$1 AND created_at < now()-interval '1 day'
      AND NOT EXISTS(SELECT 1 FROM message_drafts d WHERE d.photo_id=m.id)
      AND NOT EXISTS(SELECT 1 FROM mtproto_broadcasts b WHERE b."photoId"=m.id)
      AND NOT EXISTS(SELECT 1 FROM delivery_campaigns c WHERE c.photo_id=m.id)`,
      [ownerId]
    );
    const usage = await client.query(
      "SELECT coalesce(sum(size),0)::bigint AS used FROM message_media WHERE owner_id=$1",
      [ownerId]
    );
    if (
      Number(usage.rows[0].used) + photo.bytes.length >
      PHOTO_OWNER_QUOTA_BYTES
    )
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          "Хранилище изображений заполнено (16 МБ). Неиспользуемые вложения очищаются автоматически через сутки.",
      });
    const id = randomUUID();
    const result = await client.query(
      `INSERT INTO message_media(id,owner_id,name,mime_type,size,width,height,sha256,content_encrypted) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${COLUMNS}`,
      [
        id,
        ownerId,
        safePhotoName(input.name, photo.mimeType),
        photo.mimeType,
        photo.bytes.length,
        photo.width,
        photo.height,
        photo.sha256,
        encryptSecret(input.dataBase64, `photo:${ownerId}:${id}`),
      ]
    );
    await client.query("COMMIT");
    return dto(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export const mediaRouter = router({
  uploadPhoto: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(256),
        mimeType: z.enum(["image/jpeg", "image/png"]),
        dataBase64: z
          .string()
          .min(4)
          .max(4 * Math.ceil(PHOTO_MAX_BYTES / 3)),
      })
    )
    .mutation(({ ctx, input }) => storePhoto(ctx.user.id, input)),
});

export function registerMediaRoutes(app: Express) {
  app.get("/api/media/:id", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    try {
      const user = await readAuthenticatedUser(req);
      if (!user) {
        res.status(401).json({ error: "UNAUTHORIZED" });
        return;
      }
      const id = String(req.params.id);
      if (!UUID.test(id) || !(await getPhotoMetadata(user.id, id))) {
        res.status(404).json({ error: "NOT_FOUND" });
        return;
      }
      const { attachment, bytes } = await getPhotoBytes(user.id, id);
      res.setHeader("Content-Type", attachment.mimeType);
      res.setHeader("Content-Length", bytes.length);
      res.setHeader(
        "Content-Disposition",
        `inline; filename*=UTF-8''${encodeURIComponent(attachment.name)}`
      );
      res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      res.end(bytes);
    } catch {
      res.status(503).json({ error: "IMAGE_UNAVAILABLE" });
    }
  });
}
