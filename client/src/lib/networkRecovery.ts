type ErrorRecord = Record<string, unknown>;

function record(value: unknown): ErrorRecord | undefined {
  return value !== null && typeof value === "object"
    ? (value as ErrorRecord)
    : undefined;
}

function errorMetadata(error: unknown) {
  let current = error;
  for (let depth = 0; depth < 4; depth++) {
    const value = record(current);
    const data = record(value?.data) ?? record(record(value?.shape)?.data);
    const response =
      record(record(value?.meta)?.response) ?? record(value?.response);
    if (data || response) return { data, response };
    current = value?.cause;
  }
  return { data: undefined, response: undefined };
}

/** Only transport errors and temporary read failures are eligible for retries. */
export function isTransientReadError(error: unknown): boolean {
  const { data, response } = errorMetadata(error);
  const status = data?.httpStatus ?? response?.status;
  if (typeof status === "number") {
    if (status === 408) return true;
    if (status >= 400 && status < 500) return false;
    if (status >= 500 && status <= 599) return true;
  }
  if (typeof data?.code === "string") {
    return [
      "INTERNAL_SERVER_ERROR",
      "BAD_GATEWAY",
      "SERVICE_UNAVAILABLE",
      "GATEWAY_TIMEOUT",
      "TIMEOUT",
    ].includes(data.code);
  }
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth++) {
    const value = record(current);
    if (!value) return false;
    if (value.name === "AbortError" || value.name === "CancelledError")
      return false;
    if (value.name === "RequestTimeoutError") return true;
    if (
      typeof value.message === "string" &&
      /^(Failed to fetch|fetch failed|Load failed|NetworkError when attempting to fetch resource\.?|Network request failed)$/.test(
        value.message
      )
    )
      return true;
    current = value.cause;
  }
  return false;
}

function retryAfterMilliseconds(
  error: unknown,
  errorUpdatedAt?: number
): number | null {
  const { response } = errorMetadata(error);
  const headers = response?.headers;
  if (!(headers instanceof Headers)) return null;
  const value = headers.get("Retry-After");
  if (!value) return null;
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const elapsed = errorUpdatedAt
      ? Math.max(0, Date.now() - errorUpdatedAt)
      : 0;
    return Math.max(0, Number(value) * 1000 - elapsed);
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? Math.max(0, timestamp - Date.now())
    : null;
}

export function shouldRetryRead(failureCount: number, error: unknown) {
  return (
    failureCount < 2 &&
    isTransientReadError(error) &&
    (retryAfterMilliseconds(error) ?? 0) <= 30_000
  );
}

export function readRetryDelay(attempt: number, error: unknown) {
  return Math.max(
    Math.min(750 * 2 ** Math.max(0, attempt), 5000),
    retryAfterMilliseconds(error) ?? 0
  );
}

type ReadQueryState = { state: { error: unknown; errorUpdatedAt?: number } };

/** Focus/reconnect may recover reads, but must retain server Retry-After. */
export function canRefetchRead(query: ReadQueryState) {
  const { error, errorUpdatedAt } = query.state;
  return (
    !error ||
    (isTransientReadError(error) &&
      (retryAfterMilliseconds(error, errorUpdatedAt) ?? 0) <= 0)
  );
}

export const sessionQueryOptions = {
  retry: shouldRetryRead,
  retryDelay: readRetryDelay,
  refetchOnWindowFocus: canRefetchRead,
  refetchOnReconnect: canRefetchRead,
  refetchIntervalInBackground: false,
  refetchInterval: (query: ReadQueryState) => {
    if (!query.state.error) return 60_000;
    return isTransientReadError(query.state.error)
      ? Math.max(
          10_000,
          retryAfterMilliseconds(
            query.state.error,
            query.state.errorUpdatedAt
          ) ?? 0
        )
      : false;
  },
};

export class RequestTimeoutError extends Error {
  constructor() {
    super("Сервер не ответил вовремя. Результат запроса не подтверждён.");
    this.name = "RequestTimeoutError";
  }
}

export class HttpResponseError extends Error {
  constructor(public readonly response: Response) {
    super(
      response.status >= 500
        ? "Связь с сервисом временно недоступна. Результат запроса не подтверждён."
        : "Сервис отклонил запрос. Повторите проверку вручную."
    );
    this.name = "HttpResponseError";
  }
}

/** One HTTP attempt only. QueryClient owns read retries; POSTs are never replayed. */
export function createRpcFetch(
  options: {
    fetcher?: typeof globalThis.fetch;
    readTimeoutMs?: number;
    writeTimeoutMs?: number;
  } = {}
): typeof globalThis.fetch {
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  return async (input, init) => {
    const request =
      typeof Request !== "undefined" && input instanceof Request
        ? input
        : undefined;
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const read = method === "GET" || method === "HEAD";
    const parentSignal = init?.signal ?? request?.signal;
    const controller = new AbortController();
    const abortFromParent = () => controller.abort(parentSignal?.reason);
    if (parentSignal?.aborted) abortFromParent();
    else
      parentSignal?.addEventListener("abort", abortFromParent, { once: true });
    let timedOut = false;
    const timeout = setTimeout(
      () => {
        timedOut = true;
        controller.abort(new DOMException("Request timed out", "TimeoutError"));
      },
      read
        ? (options.readTimeoutMs ?? 15_000)
        : (options.writeTimeoutMs ?? 45_000)
    );
    try {
      if (parentSignal?.aborted) throw parentSignal.reason;
      const response = await fetcher(input, {
        ...init,
        signal: controller.signal,
        credentials: "include",
        cache: "no-store",
      });
      if (response.status === 0) return response;
      if (!response.body) {
        if (!response.ok) throw new HttpResponseError(response);
        return response;
      }
      // Include body download in the deadline, not only response headers.
      const bytes = await response.arrayBuffer();
      const complete = new Response(bytes, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
      // tRPC loses response metadata if parsing an edge HTML error page fails.
      // Keep status/Retry-After in our typed cause before handing it to the SDK.
      if (!complete.ok && complete.status >= 500)
        throw new HttpResponseError(complete);
      if (!complete.ok) {
        try {
          JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          throw new HttpResponseError(complete);
        }
      }
      return complete;
    } catch (error) {
      if (timedOut && !parentSignal?.aborted) throw new RequestTimeoutError();
      if (parentSignal?.aborted) throw parentSignal.reason;
      throw error;
    } finally {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abortFromParent);
    }
  };
}
