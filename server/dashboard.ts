import { getPool } from "./connection";
import { getBroadcasts } from "./db";
import { getProgress } from "./delivery";
export async function dashboard(ownerId: number) {
  const counts = await getPool().query(
    `SELECT count(*)::int AS campaigns,COALESCE(sum(s.accepted),0)::int AS accepted,COALESCE(sum(s.attempted),0)::int AS attempted
    FROM delivery_campaigns c LEFT JOIN LATERAL (SELECT count(*) FILTER(WHERE state='accepted') AS accepted,count(*) FILTER(WHERE state IN ('accepted','failed','unknown')) AS attempted FROM deliveries WHERE campaign_id=c.id) s ON true WHERE c.owner_id=$1 AND NOT c.is_dry_run`,
    [ownerId]
  );
  const row = counts.rows[0];
  const total = await getPool().query(
    'SELECT (SELECT count(*) FROM broadcasts WHERE "userId"=$1)+(SELECT count(*) FROM mtproto_broadcasts WHERE "userId"=$1) AS count',
    [ownerId]
  );
  const recentBroadcasts = await Promise.all(
    (await getBroadcasts(ownerId)).slice(0, 5).map(async item => {
      const progress = await getProgress(ownerId, "bot", item.id);
      return {
        ...item,
        status: progress?.status ?? item.status,
        sentCount: progress?.accepted ?? item.sentCount,
        failedCount: progress?.failed ?? item.failedCount,
      };
    })
  );
  return {
    totalBroadcasts: Number(total.rows[0].count),
    totalMessagesSent: Number(row.accepted),
    overallSuccessRate: row.attempted
      ? Math.round((row.accepted / row.attempted) * 1000) / 10
      : 0,
    recentBroadcasts,
  };
}
