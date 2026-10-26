import { Duplex } from "node:stream";

const MAX_CHUNK_BYTES = 3 * 1024 * 1024;
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const MAX_SESSION_MS = 90_000;
const TARGET_HOST = "aws-1-eu-central-1.pooler.supabase.com";
const TARGET_PORT = 5432;

type WriteCallback = (error?: Error | null) => void;
type RelayEvent = { data?: unknown };

// Workers adds accept() and upgrade responses to the WebSocket/fetch APIs.
// Keep that small interface local so the Node server needs no Workers globals.
export interface RelayWebSocket {
  binaryType: string;
  accept(): void;
  send(data: ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: RelayEvent) => void): void;
  removeEventListener(
    type: string,
    listener: (event: RelayEvent) => void
  ): void;
}

export interface RelayUpgradeResponse {
  status: number;
  webSocket?: RelayWebSocket | null;
  body?: { cancel(): Promise<unknown> } | null;
}

export interface RelayDependencies {
  fetch(url: string, init: RequestInit): Promise<RelayUpgradeResponse>;
}

export interface SupabaseRelayConfiguration {
  url: string;
  token: string;
  anonKey: string;
  host: string;
  port: number;
}

function unavailable(reason: string): Error {
  // Never retain a fetch/WS exception: it may include an authorization header,
  // database password, or connection URL in its message or cause.
  return new Error(`Database relay ${reason}`);
}

function relayProjectRef(value: string): string {
  let relay: URL;
  try {
    relay = new URL(value);
  } catch {
    throw unavailable("URL is invalid");
  }
  const match = /^([a-z]{20})\.supabase\.co$/.exec(relay.hostname);
  if (
    relay.protocol !== "https:" ||
    !match ||
    relay.username ||
    relay.password ||
    relay.port ||
    relay.search ||
    relay.hash ||
    relay.pathname !== "/functions/v1/tg-postgres-relay" ||
    // Reject alternate spellings (such as an explicit :443) before forwarding
    // either credential, even when URL normalisation would remove them.
    value !== `https://${match[1]}.supabase.co/functions/v1/tg-postgres-relay`
  )
    throw unavailable("URL is invalid");
  return match[1];
}

function validateRelayCredentials(
  token: string,
  anonKey: string,
  projectRef: string
): void {
  if (token.length !== 43 || !/^[A-Za-z0-9_-]{43}$/.test(token))
    throw unavailable("token is invalid");
  if (
    /[\r\n]/.test(anonKey) ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(anonKey)
  )
    throw unavailable("public key is invalid");
  try {
    const payload = JSON.parse(
      Buffer.from(anonKey.split(".")[1], "base64url").toString("utf8")
    );
    if (payload.role !== "anon" || payload.ref !== projectRef)
      throw unavailable("public key is invalid");
  } catch {
    throw unavailable("public key is invalid");
  }
}

export function supabaseRelayConfiguration(
  env: NodeJS.ProcessEnv,
  databaseUrl: URL
): SupabaseRelayConfiguration {
  const url = env.DATABASE_RELAY_URL || "";
  const projectRef = relayProjectRef(url);
  const token = env.DATABASE_RELAY_TOKEN || "";
  const anonKey = env.DATABASE_RELAY_ANON_KEY || "";
  validateRelayCredentials(token, anonKey, projectRef);
  let databaseUser: string;
  try {
    databaseUser = decodeURIComponent(databaseUrl.username);
  } catch {
    throw unavailable("database target is invalid");
  }
  if (
    databaseUrl.hostname !== TARGET_HOST ||
    databaseUrl.port !== String(TARGET_PORT) ||
    databaseUrl.pathname !== "/postgres" ||
    databaseUser !== `tg_sender_v2.${projectRef}`
  )
    throw unavailable("database target is invalid");
  return {
    url,
    token,
    anonKey,
    host: TARGET_HOST,
    port: TARGET_PORT,
  };
}

/** One WebSocket is one PostgreSQL session; interrupted sessions never resume. */
export class SupabaseRelaySocket extends Duplex {
  private readonly configuration: SupabaseRelayConfiguration;
  private started = false;
  private socket?: RelayWebSocket;
  private socketCloseRequested = false;
  private ending = false;
  private pendingWrite?: { data: Buffer; callback: WriteCallback };
  private readonly abort = new AbortController();
  private lifetimeTimer?: ReturnType<typeof setTimeout>;
  private closeTimer?: ReturnType<typeof setTimeout>;

  constructor(
    configuration: SupabaseRelayConfiguration,
    private readonly dependencies: RelayDependencies = {
      fetch: (url, init) => fetch(url, init),
    }
  ) {
    super({
      allowHalfOpen: false,
      autoDestroy: true,
      readableHighWaterMark: 64 * 1024,
      writableHighWaterMark: 64 * 1024,
    });
    const projectRef = relayProjectRef(configuration.url);
    validateRelayCredentials(
      configuration.token,
      configuration.anonKey,
      projectRef
    );
    if (
      configuration.host !== TARGET_HOST ||
      configuration.port !== TARGET_PORT
    )
      throw unavailable("database target is invalid");
    this.configuration = { ...configuration };
  }

  connect(port: number, host: string): this {
    if (
      this.started ||
      port !== this.configuration.port ||
      host !== this.configuration.host
    ) {
      queueMicrotask(() => this.destroy(unavailable("connection is invalid")));
      return this;
    }
    this.started = true;
    this.lifetimeTimer = setTimeout(
      () => this.destroy(unavailable("session expired")),
      MAX_SESSION_MS
    );
    this.lifetimeTimer.unref?.();
    // pg attaches connect/error/data listeners after calling connect().
    void Promise.resolve().then(() => this.open());
    return this;
  }

  setNoDelay(_enabled?: boolean): this {
    return this;
  }

  setKeepAlive(_enabled?: boolean, _delay?: number): this {
    return this;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }

  private async open(): Promise<void> {
    if (this.destroyed) return;
    let response: RelayUpgradeResponse;
    try {
      response = await this.dependencies.fetch(this.configuration.url, {
        method: "GET",
        headers: {
          Upgrade: "websocket",
          Authorization: `Bearer ${this.configuration.anonKey}`,
          "x-tg-relay-token": this.configuration.token,
        },
        // Workers currently accepts manual/follow only. Reject every non-101
        // response below, so redirects can never forward either credential.
        redirect: "manual",
        signal: this.abort.signal,
      });
    } catch {
      if (!this.destroyed) this.destroy(unavailable("upgrade failed"));
      return;
    }
    if (this.destroyed || response.status !== 101 || !response.webSocket) {
      this.closeSocket(response.webSocket || undefined);
      try {
        await response.body?.cancel();
      } catch {
        // A failed upgrade must not retain a response stream or its error.
      }
      if (!this.destroyed) this.destroy(unavailable("upgrade failed"));
      return;
    }
    this.socket = response.webSocket;
    try {
      this.socket.binaryType = "arraybuffer";
      this.socket.addEventListener("message", this.onMessage);
      this.socket.addEventListener("close", this.onClose);
      this.socket.addEventListener("error", this.onError);
      this.socket.accept();
      if (this.destroyed) return;
      const pending = this.pendingWrite;
      this.pendingWrite = undefined;
      if (pending) this.send(pending.data, pending.callback);
      if (!this.destroyed) this.emit("connect");
    } catch {
      this.destroy(unavailable("upgrade failed"));
    }
  }

  private readonly onMessage = (event: RelayEvent): void => {
    if (this.destroyed) return;
    let bytes: Uint8Array;
    if (event.data instanceof ArrayBuffer) bytes = new Uint8Array(event.data);
    else if (ArrayBuffer.isView(event.data))
      bytes = new Uint8Array(
        event.data.buffer,
        event.data.byteOffset,
        event.data.byteLength
      );
    else {
      this.destroy(unavailable("received an invalid frame"));
      return;
    }
    if (
      bytes.byteLength > MAX_CHUNK_BYTES ||
      this.readableLength + bytes.byteLength > MAX_BUFFER_BYTES
    ) {
      this.destroy(unavailable("receive buffer limit exceeded"));
      return;
    }
    // pg-protocol requires Buffer; copy so event storage cannot mutate it.
    this.push(Buffer.from(bytes));
  };

  private readonly onClose = (): void => {
    if (this.destroyed) return;
    this.push(null);
    this.destroy(
      this.ending ? undefined : unavailable("connection closed unexpectedly")
    );
  };

  private readonly onError = (): void => {
    if (!this.destroyed) this.destroy(unavailable("connection failed"));
  };

  override _read(): void {
    // Workers WebSockets cannot pause network delivery. onMessage enforces the
    // hard readable buffer cap even when a pg consumer stops reading.
  }

  override write(chunk: unknown, callback?: WriteCallback): boolean;
  override write(
    chunk: unknown,
    encoding: BufferEncoding,
    callback?: WriteCallback
  ): boolean;
  override write(
    chunk: unknown,
    encodingOrCallback?: BufferEncoding | WriteCallback,
    callback?: WriteCallback
  ): boolean {
    const encoding =
      typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
    const complete =
      typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    const byteLength =
      typeof chunk === "string"
        ? Buffer.byteLength(chunk, encoding)
        : chunk instanceof Uint8Array
          ? chunk.byteLength
          : 0;
    if (
      byteLength > MAX_CHUNK_BYTES ||
      this.writableLength + byteLength > MAX_BUFFER_BYTES
    ) {
      const error = unavailable("send buffer limit exceeded");
      queueMicrotask(() => {
        complete?.(error);
        this.destroy(error);
      });
      return false;
    }
    return typeof encodingOrCallback === "function"
      ? super.write(chunk, encodingOrCallback)
      : super.write(chunk, encoding || "utf8", callback);
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: WriteCallback
  ): void {
    if (!this.socket) {
      this.pendingWrite = { data: chunk, callback };
      return;
    }
    this.send(chunk, callback);
  }

  private send(data: Buffer, callback: WriteCallback): void {
    try {
      if (!this.socket || this.destroyed || this.ending)
        throw unavailable("connection is closed");
      this.socket.send(data);
      // This means accepted by the Workers runtime, never confirmed by PG.
      callback();
    } catch {
      callback(unavailable("write failed"));
    }
  }

  override _final(callback: WriteCallback): void {
    this.ending = true;
    if (!this.socket) {
      callback();
      this.destroy();
      return;
    }
    this.closeSocket(this.socket);
    callback();
    if (!this.destroyed) {
      this.closeTimer = setTimeout(() => this.destroy(), 1_000);
      this.closeTimer.unref?.();
    }
  }

  private closeSocket(socket?: RelayWebSocket): void {
    if (!socket) return;
    if (socket === this.socket) {
      if (this.socketCloseRequested) return;
      this.socketCloseRequested = true;
    }
    try {
      socket.close(1000);
    } catch {
      // A failed, unaccepted, or already closed socket needs no retry.
    }
  }

  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void
  ): void {
    this.abort.abort();
    if (this.lifetimeTimer) clearTimeout(this.lifetimeTimer);
    if (this.closeTimer) clearTimeout(this.closeTimer);
    const pending = this.pendingWrite;
    this.pendingWrite = undefined;
    if (this.socket) {
      this.socket.removeEventListener("message", this.onMessage);
      this.socket.removeEventListener("close", this.onClose);
      this.socket.removeEventListener("error", this.onError);
      this.closeSocket(this.socket);
    }
    pending?.callback(error || unavailable("connection is closed"));
    callback(error);
  }
}

export function createSupabaseRelayStream(
  configuration: SupabaseRelayConfiguration,
  dependencies?: RelayDependencies
): () => SupabaseRelaySocket {
  // A factory is required: pg-pool reuses PoolConfig across all clients.
  return () => new SupabaseRelaySocket(configuration, dependencies);
}
