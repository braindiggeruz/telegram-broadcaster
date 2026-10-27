const launchProcedures = new Set(["broadcast.launch", "mtproto.launchBroadcast"]);
const prefix = "/api/trpc/";

/** Only a committed, successful launch result may wake the durable queue. */
export async function shouldKickDelivery(
  request: Request,
  response: Response
): Promise<boolean> {
  if (request.method !== "POST" || !response.ok) return false;
  const url = new URL(request.url);
  if (!url.pathname.startsWith(prefix)) return false;
  try {
    const paths = decodeURIComponent(url.pathname.slice(prefix.length)).split(
      ","
    );
    if (!paths.some(path => launchProcedures.has(path))) return false;
    const batched = url.searchParams.get("batch") === "1";
    const payload: unknown = await response.clone().json();
    const results = batched ? payload : [payload];
    if (!Array.isArray(results) || results.length !== paths.length) return false;
    return paths.some((path, index) => {
      if (!launchProcedures.has(path)) return false;
      const result = results[index];
      const item = result as {
        result?: { data?: { json?: { started?: unknown } } };
      } | null;
      return (
        result !== null &&
        typeof result === "object" &&
        !("error" in result) &&
        item?.result?.data?.json?.started === true
      );
    });
  } catch {
    // A malformed response must not turn a successful request into an error or
    // cause unrelated work to run. Cron remains the durable fallback.
    return false;
  }
}
