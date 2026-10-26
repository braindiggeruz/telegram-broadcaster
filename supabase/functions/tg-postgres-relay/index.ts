// Deploy with verify_jwt: true. No credentials or wire payloads are logged.
const PROJECT_REF = 'pdulckpafwbgpgotfzir';
const HOST = 'aws-1-eu-central-1.pooler.supabase.com';
const PORT = 5432;
const CA_PEM = "-----BEGIN CERTIFICATE-----\nMIIDxDCCAqygAwIBAgIUbLxMod62P2ktCiAkxnKJwtE9VPYwDQYJKoZIhvcNAQEL\nBQAwazELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5l\ndyBDYXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJh\nc2UgUm9vdCAyMDIxIENBMB4XDTIxMDQyODEwNTY1M1oXDTMxMDQyNjEwNTY1M1ow\nazELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5ldyBD\nYXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJhc2Ug\nUm9vdCAyMDIxIENBMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqQXW\nQyHOB+qR2GJobCq/CBmQ40G0oDmCC3mzVnn8sv4XNeWtE5XcEL0uVih7Jo4Dkx1Q\nDmGHBH1zDfgs2qXiLb6xpw/CKQPypZW1JssOTMIfQppNQ87K75Ya0p25Y3ePS2t2\nGtvHxNjUV6kjOZjEn2yWEcBdpOVCUYBVFBNMB4YBHkNRDa/+S4uywAoaTWnCJLUi\ncvTlHmMw6xSQQn1UfRQHk50DMCEJ7Cy1RxrZJrkXXRP3LqQL2ijJ6F4yMfh+Gyb4\nO4XajoVj/+R4GwywKYrrS8PrSNtwxr5StlQO8zIQUSMiq26wM8mgELFlS/32Uclt\nNaQ1xBRizkzpZct9DwIDAQABo2AwXjALBgNVHQ8EBAMCAQYwHQYDVR0OBBYEFKjX\nuXY32CztkhImng4yJNUtaUYsMB8GA1UdIwQYMBaAFKjXuXY32CztkhImng4yJNUt\naUYsMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAB8spzNn+4VU\ntVxbdMaX+39Z50sc7uATmus16jmmHjhIHz+l/9GlJ5KqAMOx26mPZgfzG7oneL2b\nVW+WgYUkTT3XEPFWnTp2RJwQao8/tYPXWEJDc0WVQHrpmnWOFKU/d3MqBgBm5y+6\njB81TU/RG2rVerPDWP+1MMcNNy0491CTL5XQZ7JfDJJ9CCmXSdtTl4uUQnSuv/Qx\nCea13BX2ZgJc7Au30vihLhub52De4P/4gonKsNHYdbWjg7OWKwNv/zitGDVDB9Y2\nCMTyZKG3XEu5Ghl1LEnI3QmEKsqaCLv12BnVjbkSeZsMnevJPs1Ye6TjjJwdik5P\no/bKiIz+Fq8=\n-----END CERTIFICATE-----\n";
const CONTEXT = new TextEncoder().encode('tg-sender:postgres-relay:v1');
const MAX_CONNECTIONS = 12;
const MAX_FRAME_BYTES = 3 * 1024 * 1024;
const MAX_QUEUE_BYTES = 8 * 1024 * 1024;
let activeConnections = 0;

function tokenBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  try { return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='), char => char.charCodeAt(0)); }
  catch { return null; }
}
async function authorized(request: Request): Promise<boolean> {
  if (Deno.env.get('SUPABASE_URL') !== `https://${PROJECT_REF}.supabase.co`) return false;
  const secret = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const signature = tokenBytes(request.headers.get('x-tg-relay-token') || '');
  if (!secret || !signature) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return await crypto.subtle.verify('HMAC', key, signature, CONTEXT);
}
async function writeAll(connection: Deno.Conn, bytes: Uint8Array) {
  let position = 0;
  while (position < bytes.length) {
    const written = await connection.write(bytes.subarray(position));
    if (written <= 0) throw new Error('Closed connection');
    position += written;
  }
}
function timeout<T>(operation: Promise<T>, milliseconds: number, closeLate?: (value: T) => void, onTimeout?: () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => { settled = true; onTimeout?.(); reject(new Error('Timeout')); }, milliseconds);
    operation.then(value => {
      if (settled) { closeLate?.(value); return; }
      settled = true; clearTimeout(timer); resolve(value);
    }, error => { if (settled) return; settled = true; clearTimeout(timer); reject(error); });
  });
}
async function verifiedConnection(): Promise<Deno.TlsConn> {
  let raw: Deno.TcpConn | undefined;
  let secure: Deno.TlsConn | undefined;
  let cancelled = false;
  try {
    return await timeout((async () => {
      raw = await Deno.connect({ hostname: HOST, port: PORT, transport: 'tcp' });
      if (cancelled) { raw.close(); throw new Error('Cancelled'); }
      const sslRequest = new Uint8Array([0, 0, 0, 8, 4, 210, 22, 47]);
      await writeAll(raw, sslRequest);
      const acknowledgement = new Uint8Array(1);
      if (await raw.read(acknowledgement) !== 1 || acknowledgement[0] !== 83) throw new Error('TLS unavailable');
      secure = await Deno.startTls(raw, { hostname: HOST, caCerts: [CA_PEM] });
      if (cancelled) { secure.close(); throw new Error('Cancelled'); }
      await secure.handshake();
      if (cancelled) { secure.close(); throw new Error('Cancelled'); }
      return secure;
    })(), 10000, value => { try { value.close(); } catch {} }, () => { cancelled = true; });
  } catch (error) {
    cancelled = true;
    try { secure?.close(); } catch {}
    try { raw?.close(); } catch {}
    throw error;
  }
}

Deno.serve(async request => {
  if (request.method !== 'GET' || request.headers.get('upgrade')?.toLowerCase() !== 'websocket' || new URL(request.url).search || !await authorized(request)) {
    return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }
  if (activeConnections >= MAX_CONNECTIONS) return new Response('Busy', { status: 503 });
  activeConnections++;
  let connection: Deno.TlsConn;
  try { connection = await verifiedConnection(); }
  catch { activeConnections--; return new Response('Database unavailable', { status: 503 }); }
  let webSocket: WebSocket;
  let response: Response;
  try { ({ socket: webSocket, response } = Deno.upgradeWebSocket(request, { idleTimeout: 0 })); }
  catch { activeConnections--; connection.close(); return new Response('Upgrade failed', { status: 400 }); }
  webSocket.binaryType = 'arraybuffer';
  let closed = false;
  let resolveClosed!: () => void;
  const completed = new Promise<void>(resolve => { resolveClosed = resolve; });
  const close = (code = 1000) => {
    if (closed) return;
    closed = true; activeConnections--; clearTimeout(deadline);
    try { connection.close(); } catch {}
    try { webSocket.close(code); } catch {}
    resolveClosed();
  };
  const deadline = setTimeout(() => close(1001), 90000);
  let queuedBytes = 0;
  let writes = Promise.resolve();
  webSocket.onmessage = event => {
    if (closed) return;
    if (!(event.data instanceof ArrayBuffer) || event.data.byteLength > MAX_FRAME_BYTES) { close(1009); return; }
    const bytes = new Uint8Array(event.data);
    queuedBytes += bytes.byteLength;
    if (queuedBytes > MAX_QUEUE_BYTES) { close(1009); return; }
    writes = writes.then(async () => {
      if (closed) return;
      await writeAll(connection, bytes);
      queuedBytes -= bytes.byteLength;
    }).catch(() => close(1011));
  };
  webSocket.onopen = () => {
    (async () => {
      const buffer = new Uint8Array(16 * 1024);
      while (!closed) {
        const count = await connection.read(buffer);
        if (count === null) { close(); return; }
        while (webSocket.bufferedAmount > 256 * 1024 && !closed) await new Promise(resolve => setTimeout(resolve, 10));
        if (closed || webSocket.readyState !== WebSocket.OPEN) return;
        if (webSocket.bufferedAmount > 1024 * 1024) { close(1009); return; }
        webSocket.send(buffer.slice(0, count));
      }
    })().catch(() => close(1011));
  };
  webSocket.onclose = () => close();
  webSocket.onerror = () => close(1011);
  EdgeRuntime.waitUntil(completed);
  return response;
});
