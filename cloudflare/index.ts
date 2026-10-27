import { createServer } from "node:http";
import { isIP } from "node:net";
// @ts-expect-error cloudflare:node is a native Workers module, absent in Node typings.
import { httpServerHandler } from "cloudflare:node";
import { createApp, securityHeaders } from "../server/_core/app";
import { runWithDatabaseScope } from "../server/connection";
import { assertSecurityConfiguration } from "../server/security/config";
import { runImmediateDeliveryBatch, runScheduledBatch } from "../server/cloudflareScheduled";
import { shouldKickDelivery } from "../server/cloudflareKick";

interface WorkerEnvironment {
  ASSETS: { fetch(request: Request): Promise<Response> };
}
interface WorkerContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

const app = createApp();
// Only this Workers entrypoint trusts one proxy hop. Forwarding headers are
// rebuilt below from Cloudflare's verified ingress metadata, never from XFF.
app.set("trust proxy", 1);
const server = createServer(app);
server.listen(8080);
const handler = httpServerHandler({ port: 8080 }) as {
  fetch(
    request: Request,
    env: WorkerEnvironment,
    context: WorkerContext
  ): Promise<Response>;
};
const RESPONSE_LIMIT = 3 * 1024 * 1024;

async function consumeResponse(response: Response): Promise<Response> {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  if (!response.body)
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  // Node's HTTP bridge can return before Express finishes using the database.
  // Consume the complete bounded body before its request-scoped pool is closed.
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > RESPONSE_LIMIT) {
        await reader.cancel();
        throw new Error("WORKER_RESPONSE_TOO_LARGE");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(securityHeaders))
    headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function trustedIngressRequest(request: Request): Request {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  headers.delete("X-Forwarded-For");
  headers.delete("X-Real-IP");
  const clientIp = request.headers.get("CF-Connecting-IP");
  if (clientIp && isIP(clientIp)) headers.set("X-Forwarded-For", clientIp);
  headers.set("X-Forwarded-Host", url.host);
  headers.set("X-Forwarded-Proto", url.protocol.slice(0, -1));
  return new Request(request, { headers });
}

export default {
  async fetch(
    request: Request,
    env: WorkerEnvironment,
    context: WorkerContext
  ): Promise<Response> {
    const path = new URL(request.url).pathname;
    const dynamic =
      path === "/api" ||
      path.startsWith("/api/") ||
      path === "/healthz" ||
      path === "/readyz";
    if (!dynamic) return withSecurityHeaders(await env.ASSETS.fetch(request));
    try {
      // Workers populates process.env from this deployment's bindings. Do not
      // copy values into mutable global state shared by concurrent invocations.
      assertSecurityConfiguration();
      const response = await runWithDatabaseScope(async () =>
        consumeResponse(
          await handler.fetch(trustedIngressRequest(request), env, context)
        )
      );
      // Leave the request's AsyncLocalStorage scope first: background work must
      // own a fresh pool rather than inherit the pool just closed above.
      if (await shouldKickDelivery(request, response))
        context.waitUntil(
          runImmediateDeliveryBatch().catch(() => {
            console.error("CLOUD_HTTP_KICK_FAILED");
          })
        );
      return response;
    } catch {
      console.error("WORKER_REQUEST_FAILED");
      return withSecurityHeaders(
        Response.json(
          { error: "SERVICE_UNAVAILABLE" },
          { status: 503, headers: { "Cache-Control": "no-store" } }
        )
      );
    }
  },
  async scheduled(): Promise<void> {
    assertSecurityConfiguration();
    await runScheduledBatch();
  },
};
