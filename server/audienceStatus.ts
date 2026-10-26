import { TRPCError } from "@trpc/server";
import type {
  AudienceStatus,
  AudienceTransport,
} from "../shared/audienceStatus";
import { getPool } from "./connection";
import { getRecipientList } from "./db";
import { normalizeRecipient, senderKey } from "./delivery/types";

/** Read-only local preflight. Never grants consent or contacts Telegram. */
export async function getAudienceStatus(
  ownerId: number,
  transport: AudienceTransport,
  listId: number
): Promise<AudienceStatus> {
  senderKey(ownerId, transport);
  const list = await getRecipientList(listId, ownerId);
  if (!list)
    throw new TRPCError({ code: "NOT_FOUND", message: "Список не найден" });

  let recipients: string[];
  try {
    const values: unknown = JSON.parse(list.chatIds);
    if (
      !Array.isArray(values) ||
      values.some(value => typeof value !== "string")
    )
      throw new Error("INVALID_LIST");
    recipients = [...new Set(values.map(value => normalizeRecipient(value)))];
  } catch {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Список получателей требует проверки формата",
    });
  }

  const { rows } = await getPool().query<Omit<AudienceStatus, "listId">>(
    `WITH members AS (
      SELECT recipient,($2::text='bot' AND recipient LIKE 'phone:%') AS unsupported
      FROM unnest($3::text[]) AS member(recipient)
    )
    SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER(WHERE NOT m.unsupported AND p.allowed AND p.suppressed_at IS NULL)::int AS allowed,
      COUNT(*) FILTER(WHERE NOT m.unsupported AND p.suppressed_at IS NULL AND NOT COALESCE(p.allowed,false))::int AS "needsConfirmation",
      COUNT(*) FILTER(WHERE NOT m.unsupported AND p.suppressed_at IS NULL AND NOT COALESCE(p.allowed,false)
        AND p.source='sender:identity_changed')::int AS "identityChanged",
      COUNT(*) FILTER(WHERE NOT m.unsupported AND p.suppressed_at IS NOT NULL)::int AS "optedOut",
      COUNT(*) FILTER(WHERE m.unsupported)::int AS unsupported
    FROM members m LEFT JOIN contact_permissions p
      ON p.owner_id=$1 AND p.kind=$2 AND p.recipient=m.recipient`,
    [ownerId, transport, recipients]
  );
  return { listId, ...rows[0] };
}
