import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import {
  createSupabaseRelayStream,
  SupabaseRelaySocket,
  supabaseRelayConfiguration,
  type RelayUpgradeResponse,
  type RelayWebSocket,
} from "./supabaseRelay";
import { databasePoolConfig } from "./connection";

const projectRef = "abcdefghijklmnopqrst";
const relayUrl = `https://${projectRef}.supabase.co/functions/v1/tg-postgres-relay`;
const databaseUrl = `postgresql://tg_sender_v2.${projectRef}:synthetic-password@aws-1-eu-central-1.pooler.supabase.com:5432/postgres`;
function syntheticJwt(role = "anon", ref = projectRef) {
  return `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role, ref })).toString("base64url")}.syntheticSignature`;
}
const environment = {
  DATABASE_URL: databaseUrl,
  DATABASE_TRANSPORT: "supabase-relay",
  DATABASE_RELAY_URL: relayUrl,
  DATABASE_RELAY_TOKEN: "t".repeat(43),
  DATABASE_RELAY_ANON_KEY: syntheticJwt(),
};
const configuration = () =>
  supabaseRelayConfiguration(environment, new URL(databaseUrl));

class TestWebSocket implements RelayWebSocket {
  binaryType = "blob";
  listeners = new Map<string, Set<(event: { data?: unknown }) => void>>();
  accept = vi.fn();
  send = vi.fn();
  close = vi.fn();
  addEventListener(
    type: string,
    listener: (event: { data?: unknown }) => void
  ) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(
    type: string,
    listener: (event: { data?: unknown }) => void
  ) {
    this.listeners.get(type)?.delete(listener);
  }
  dispatch(type: string, data?: unknown) {
    for (const listener of this.listeners.get(type) || []) listener({ data });
  }
}

const sockets: SupabaseRelaySocket[] = [];
async function flush() {
  await new Promise<void>(resolve => setImmediate(resolve));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => {
    resolve = complete;
  });
  return { promise, resolve };
}
function fixture(
  fetch = vi.fn(async () => ({ status: 101, webSocket: new TestWebSocket() }))
) {
  const socket = new SupabaseRelaySocket(configuration(), { fetch });
  const errors: Error[] = [];
  socket.on("error", error => errors.push(error));
  sockets.push(socket);
  return { socket, fetch, errors };
}
async function connectedFixture(webSocket = new TestWebSocket()) {
  const result = fixture(vi.fn(async () => ({ status: 101, webSocket })));
  result.socket.connect(5432, configuration().host);
  await flush();
  expect(webSocket.accept).toHaveBeenCalledOnce();
  return { ...result, webSocket };
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  vi.useRealTimers();
  await flush();
});

describe("Supabase PostgreSQL relay configuration", () => {
  it("rejects endpoints that could redirect credentials before opening a socket", () => {
    for (const url of [
      "https://attacker.example/functions/v1/tg-postgres-relay",
      `http://${projectRef}.supabase.co/functions/v1/tg-postgres-relay`,
      `${relayUrl}?target=attacker`,
      `${relayUrl}#fragment`,
      `${relayUrl}/`,
      relayUrl.replace("https://", "https://user:password@"),
      relayUrl.replace(".co/", ".co:443/"),
      relayUrl.replace(".co/", ".co:8443/"),
      relayUrl.replace("supabase.co", "supabase.co.attacker.example"),
    ]) {
      expect(() =>
        supabaseRelayConfiguration(
          { ...environment, DATABASE_RELAY_URL: url },
          new URL(databaseUrl)
        )
      ).toThrow("Database relay URL is invalid");
      expect(
        () => new SupabaseRelaySocket({ ...configuration(), url })
      ).toThrow("Database relay URL is invalid");
    }
  });

  it("binds the relay project to the least privilege database role and session pool", () => {
    for (const changed of [
      databaseUrl.replace(
        `tg_sender_v2.${projectRef}`,
        `postgres.${projectRef}`
      ),
      databaseUrl.replace(projectRef, "zzzzzzzzzzzzzzzzzzzz"),
      databaseUrl.replace(":5432/", ":6543/"),
      databaseUrl.replace(
        "aws-1-eu-central-1.pooler.supabase.com",
        "db.example"
      ),
      databaseUrl.replace("/postgres", "/other"),
    ])
      expect(() =>
        supabaseRelayConfiguration(environment, new URL(changed))
      ).toThrow("Database relay database target is invalid");
    for (const changed of [
      { DATABASE_RELAY_TOKEN: "short" },
      { DATABASE_RELAY_TOKEN: "a".repeat(43) + "\n" },
      { DATABASE_RELAY_ANON_KEY: "not-a-jwt" },
      { DATABASE_RELAY_ANON_KEY: "synthetic.public.jwt\n" },
      { DATABASE_RELAY_ANON_KEY: syntheticJwt("service_role") },
      { DATABASE_RELAY_ANON_KEY: syntheticJwt("anon", "zzzzzzzzzzzzzzzzzzzz") },
    ])
      expect(() =>
        supabaseRelayConfiguration(
          { ...environment, ...changed },
          new URL(databaseUrl)
        )
      ).toThrow("Database relay");
  });

  it("uses an explicit per-client stream factory and keeps direct TLS unchanged", () => {
    const configured = databasePoolConfig(environment);
    expect(configured.ssl).toBe(false);
    expect(configured.enableChannelBinding).toBe(false);
    expect(configured.connectionTimeoutMillis).toBe(15_000);
    const first = configured.stream!() as SupabaseRelaySocket;
    const second = configured.stream!() as SupabaseRelaySocket;
    sockets.push(first, second);
    expect(first).not.toBe(second);
    const direct = databasePoolConfig({ DATABASE_URL: databaseUrl });
    expect(direct.ssl).toEqual({ rejectUnauthorized: true });
    expect(direct.stream).toBeUndefined();
    expect(direct.connectionTimeoutMillis).toBe(5_000);
  });
});

describe("Supabase PostgreSQL relay sessions", () => {
  it("carries a real pg client startup, query result, and graceful session shutdown", async () => {
    const webSocket = new TestWebSocket();
    function int(value: number, bytes = 4) {
      const buffer = Buffer.alloc(bytes);
      if (bytes === 2) buffer.writeInt16BE(value);
      else buffer.writeInt32BE(value);
      return buffer;
    }
    function frame(type: string, payload: Buffer) {
      return Buffer.concat([
        Buffer.from(type),
        int(payload.length + 4),
        payload,
      ]);
    }
    function incoming(...frames: Buffer[]) {
      queueMicrotask(() =>
        webSocket.dispatch("message", Buffer.concat(frames))
      );
    }
    const ready = frame("Z", Buffer.from("I"));
    webSocket.send.mockImplementation((bytes: Buffer) => {
      if (bytes[0] === 0) {
        incoming(frame("R", int(0)), ready);
      } else if (bytes[0] === 81) {
        incoming(
          frame(
            "T",
            Buffer.concat([
              int(1, 2),
              Buffer.from("one\0"),
              int(0),
              int(0, 2),
              int(23),
              int(4, 2),
              int(-1),
              int(0, 2),
            ])
          ),
          frame("D", Buffer.concat([int(1, 2), int(1), Buffer.from("1")])),
          frame("C", Buffer.from("SELECT 1\0")),
          ready
        );
      }
    });
    webSocket.close.mockImplementation(() => {
      queueMicrotask(() => webSocket.dispatch("close"));
    });
    const fetch = vi.fn(async () => ({ status: 101, webSocket }));
    const factory = createSupabaseRelayStream(configuration(), { fetch });
    const client = new Client({
      connectionString: databaseUrl,
      ssl: false,
      stream: () => {
        const socket = factory();
        sockets.push(socket);
        return socket;
      },
      connectionTimeoutMillis: 1_000,
    });
    try {
      await client.connect();
      const result = await client.query("select 1 as one");
      expect(result.rows).toEqual([{ one: 1 }]);
      expect(result.rowCount).toBe(1);
    } finally {
      await client.end();
    }
    expect(fetch).toHaveBeenCalledOnce();
    expect(webSocket.close).toHaveBeenCalledOnce();
    expect(webSocket.send.mock.calls.at(-1)?.[0][0]).toBe(88);
  });

  it("opens one authenticated, nonredirecting socket per pg stream asynchronously", async () => {
    const fetch = vi.fn(async () => ({
      status: 101,
      webSocket: new TestWebSocket(),
    }));
    const factory = createSupabaseRelayStream(configuration(), { fetch });
    const first = factory();
    const second = factory();
    sockets.push(first, second);
    first.on("error", () => undefined);
    second.on("error", () => undefined);
    first.connect(5432, configuration().host);
    const connect = vi.fn();
    first.once("connect", connect);
    second.connect(5432, configuration().host);
    expect(connect).not.toHaveBeenCalled();
    await flush();
    expect(connect).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledWith(relayUrl, {
      method: "GET",
      headers: {
        Upgrade: "websocket",
        Authorization: `Bearer ${environment.DATABASE_RELAY_ANON_KEY}`,
        "x-tg-relay-token": environment.DATABASE_RELAY_TOKEN,
      },
      redirect: "manual",
      signal: expect.any(AbortSignal),
    });
    expect(fetch.mock.results[0]).not.toBe(fetch.mock.results[1]);
  });

  it("passes binary protocol bytes in both directions and drains a preconnect write", async () => {
    const upgrade = deferred<RelayUpgradeResponse>();
    const webSocket = new TestWebSocket();
    const { socket } = fixture(vi.fn(() => upgrade.promise) as never);
    socket.connect(5432, configuration().host);
    const written = vi.fn();
    socket.write(Buffer.from([0, 3, 0, 0]), written);
    expect(written).not.toHaveBeenCalled();
    const received: Buffer[] = [];
    socket.on("data", data => received.push(data));
    upgrade.resolve({ status: 101, webSocket });
    await flush();
    expect(webSocket.binaryType).toBe("arraybuffer");
    expect(webSocket.send).toHaveBeenCalledWith(Buffer.from([0, 3, 0, 0]));
    expect(written).toHaveBeenCalledOnce();
    const bytes = new Uint8Array([82, 0, 0, 0, 8]);
    webSocket.dispatch("message", bytes.buffer);
    bytes[0] = 0;
    await flush();
    expect(received).toEqual([Buffer.from([82, 0, 0, 0, 8])]);
  });

  it("aborts a pending fetch and closes a late upgrade without connecting", async () => {
    const upgrade = deferred<RelayUpgradeResponse>();
    const fetch = vi.fn(() => upgrade.promise);
    const { socket, errors } = fixture(fetch as never);
    const connect = vi.fn();
    socket.on("connect", connect);
    socket.connect(5432, configuration().host);
    await flush();
    const signal = fetch.mock.calls[0][1].signal;
    socket.destroy();
    const webSocket = new TestWebSocket();
    upgrade.resolve({ status: 101, webSocket });
    await flush();
    expect(signal?.aborted).toBe(true);
    expect(webSocket.close).toHaveBeenCalledOnce();
    expect(webSocket.accept).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
  });

  it("cleans up rejected upgrades without retaining response or upstream exceptions", async () => {
    const webSocket = new TestWebSocket();
    const cancel = vi.fn(async () => undefined);
    const rejected = fixture(
      vi.fn(async () => ({ status: 403, webSocket, body: { cancel } })) as never
    );
    rejected.socket.connect(5432, configuration().host);
    await flush();
    expect(cancel).toHaveBeenCalledOnce();
    expect(webSocket.close).toHaveBeenCalledOnce();
    expect(rejected.errors.map(error => error.message)).toEqual([
      "Database relay upgrade failed",
    ]);
    const failure = fixture(
      vi.fn(async () => {
        throw new Error("secret-password Authorization: private-token");
      }) as never
    );
    failure.socket.connect(5432, configuration().host);
    await flush();
    expect(failure.errors.map(error => error.message)).toEqual([
      "Database relay upgrade failed",
    ]);
    expect(failure.errors[0].cause).toBeUndefined();
  });

  it("rejects redirects without following them with relay credentials", async () => {
    const cancel = vi.fn(async () => undefined);
    const fetch = vi.fn(async (_url: string, options: RequestInit) => {
      expect(options.redirect).toBe("manual");
      return {
        status: 302,
        headers: new Headers({ Location: "https://attacker.example/" }),
        body: { cancel },
      };
    });
    const { socket, errors } = fixture(fetch as never);
    socket.connect(5432, configuration().host);
    await flush();
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toBe(relayUrl);
    expect(cancel).toHaveBeenCalledOnce();
    expect(socket.destroyed).toBe(true);
    expect(errors.map(error => error.message)).toEqual([
      "Database relay upgrade failed",
    ]);
  });

  it("fails a destination mismatch without sending relay credentials", async () => {
    const { socket, fetch, errors } = fixture();
    socket.connect(6543, "attacker.example");
    await flush();
    expect(fetch).not.toHaveBeenCalled();
    expect(errors.map(error => error.message)).toEqual([
      "Database relay connection is invalid",
    ]);
  });

  it("notifies pg exactly once on unexpected session loss and never reconnects", async () => {
    const { socket, webSocket, fetch, errors } = await connectedFixture();
    const closed = vi.fn();
    socket.on("close", closed);
    webSocket.dispatch("close");
    webSocket.dispatch("error");
    await flush();
    expect(errors.map(error => error.message)).toEqual([
      "Database relay connection closed unexpectedly",
    ]);
    expect(closed).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    expect(webSocket.close).toHaveBeenCalledOnce();
    expect([...webSocket.listeners.values()].every(set => set.size === 0)).toBe(
      true
    );
  });

  it("fails closed on text, oversized inbound frames, or unread buffer growth", async () => {
    for (const payloads of [
      ["unexpected text"],
      [new Uint8Array(3 * 1024 * 1024 + 1)],
      Array.from({ length: 3 }, () => new Uint8Array(3 * 1024 * 1024)),
    ]) {
      const { socket, webSocket, errors } = await connectedFixture();
      for (const payload of payloads) webSocket.dispatch("message", payload);
      await flush();
      expect(socket.destroyed).toBe(true);
      expect(errors).toHaveLength(1);
      expect(webSocket.close).toHaveBeenCalledOnce();
    }
  });

  it("bounds outbound frames and queued data before the upgrade completes", async () => {
    const never = new Promise<RelayUpgradeResponse>(() => undefined);
    for (const writes of [
      [Buffer.alloc(3 * 1024 * 1024 + 1)],
      Array.from({ length: 3 }, () => Buffer.alloc(3 * 1024 * 1024)),
    ]) {
      const { socket, errors } = fixture(vi.fn(() => never) as never);
      socket.connect(5432, configuration().host);
      const callbacks = writes.map(() => vi.fn());
      writes.forEach((bytes, index) => socket.write(bytes, callbacks[index]));
      await flush();
      expect(socket.destroyed).toBe(true);
      expect(errors.map(error => error.message)).toEqual([
        "Database relay send buffer limit exceeded",
      ]);
      for (const callback of callbacks) expect(callback).toHaveBeenCalledOnce();
    }
  });

  it("fails a send without replaying bytes or exposing the websocket exception", async () => {
    const { socket, webSocket, fetch, errors } = await connectedFixture();
    webSocket.send.mockImplementationOnce(() => {
      throw new Error("private exception containing credentials");
    });
    const written = vi.fn();
    socket.write(Buffer.from([1, 2]), written);
    await flush();
    expect(written).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Database relay write failed" })
    );
    expect(errors.map(error => error.message)).toEqual([
      "Database relay write failed",
    ]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(webSocket.send).toHaveBeenCalledOnce();
  });

  it("closes gracefully once after pg ends the connection", async () => {
    const { socket, webSocket, errors } = await connectedFixture();
    const finished = vi.fn();
    socket.end(Buffer.from([88, 0, 0, 0, 4]), finished);
    await flush();
    webSocket.dispatch("close");
    await flush();
    expect(finished).toHaveBeenCalledOnce();
    expect(errors).toEqual([]);
    expect(socket.destroyed).toBe(true);
    expect(webSocket.close).toHaveBeenCalledOnce();
  });

  it("expires a session without reconnecting or keeping a pg lock alive", async () => {
    const { socket, webSocket, fetch, errors } = await connectedFixture();
    socket.destroy();
    await flush();
    vi.useFakeTimers();
    const timed = fixture(vi.fn(async () => ({ status: 101, webSocket })));
    timed.socket.connect(5432, configuration().host);
    await vi.advanceTimersByTimeAsync(90_001);
    expect(timed.socket.destroyed).toBe(true);
    expect(timed.errors.map(error => error.message)).toEqual([
      "Database relay session expired",
    ]);
    expect(timed.fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    expect(errors).toEqual([]);
  });
});
