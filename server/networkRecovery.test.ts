import { afterEach, describe, expect, it, vi } from "vitest";
import {
  QueryClient,
  MutationObserver,
  onlineManager,
} from "@tanstack/react-query";
import {
  TRPCClientError,
  createTRPCUntypedClient,
  httpBatchLink,
} from "@trpc/client";
import {
  createRpcFetch,
  isTransientReadError,
  shouldRetryRead,
  readRetryDelay,
  sessionQueryOptions,
  RequestTimeoutError,
  canRefetchRead,
} from "../client/src/lib/networkRecovery";

afterEach(() => {
  vi.useRealTimers();
  onlineManager.setOnline(true);
});

describe("read recovery policy", () => {
  it.each([
    "Failed to fetch",
    "fetch failed",
    "Load failed",
    "NetworkError when attempting to fetch resource.",
  ])("recovers a real tRPC wrapper around %s", message => {
    const wrapped = TRPCClientError.from(new TypeError(message));
    expect(isTransientReadError(wrapped)).toBe(true);
    expect(shouldRetryRead(0, wrapped)).toBe(true);
    expect(shouldRetryRead(1, wrapped)).toBe(true);
    expect(shouldRetryRead(2, wrapped)).toBe(false);
  });
  it.each([400, 401, 403, 404, 409, 412, 429])(
    "does not retry HTTP %s",
    httpStatus => {
      expect(
        shouldRetryRead(0, {
          data: { httpStatus },
          cause: new TypeError("Failed to fetch"),
        })
      ).toBe(false);
    }
  );
  it.each([500, 502, 503, 504, 522, 524])(
    "recovers temporary HTTP %s",
    status => {
      expect(
        shouldRetryRead(0, {
          meta: { response: new Response("temporary", { status }) },
        })
      ).toBe(true);
    }
  );
  it("does not retry cancellation or a code/validation error", () => {
    expect(
      shouldRetryRead(0, new DOMException("cancelled", "AbortError"))
    ).toBe(false);
    expect(
      shouldRetryRead(0, new TypeError("Cannot read properties of undefined"))
    ).toBe(false);
    expect(shouldRetryRead(0, { data: { code: "FORBIDDEN" } })).toBe(false);
  });
  it("honors Retry-After and backs off automatic session recovery", () => {
    const error = {
      meta: {
        response: new Response("temporary", {
          status: 503,
          headers: { "Retry-After": "120" },
        }),
      },
    };
    expect(shouldRetryRead(0, error)).toBe(false);
    expect(readRetryDelay(0, error)).toBe(120_000);
    expect(sessionQueryOptions.refetchInterval({ state: { error } })).toBe(
      120_000
    );
    expect(
      sessionQueryOptions.refetchInterval({ state: { error: null } })
    ).toBe(60_000);
    expect(
      sessionQueryOptions.refetchInterval({
        state: { error: new TypeError("Failed to fetch") },
      })
    ).toBe(10_000);
    expect(
      sessionQueryOptions.refetchInterval({
        state: { error: { data: { httpStatus: 403 } } },
      })
    ).toBe(false);
  });
  it("retries a failed read and recovers using the actual query engine", async () => {
    const queryClient = new QueryClient();
    const queryFn = vi
      .fn()
      .mockRejectedValueOnce(
        TRPCClientError.from(new TypeError("Failed to fetch"))
      )
      .mockResolvedValue({ id: 17 });
    try {
      const value = await queryClient.fetchQuery({
        queryKey: ["synthetic-session"],
        queryFn,
        retry: shouldRetryRead,
        retryDelay: 0,
      });
      expect(value).toEqual({ id: 17 });
      expect(queryFn).toHaveBeenCalledTimes(2);
    } finally {
      queryClient.clear();
    }
  });
  it("bounds a persistent read failure to three attempts", async () => {
    const queryClient = new QueryClient();
    const queryFn = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    try {
      await expect(
        queryClient.fetchQuery({
          queryKey: ["synthetic-session"],
          queryFn,
          retry: shouldRetryRead,
          retryDelay: 0,
        })
      ).rejects.toThrow("Failed to fetch");
      expect(queryFn).toHaveBeenCalledTimes(3);
    } finally {
      queryClient.clear();
    }
  });
  it("never replays a mutation after the response is lost", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: shouldRetryRead },
        mutations: { retry: false },
      },
    });
    const mutationFn = vi
      .fn()
      .mockRejectedValue(new TypeError("Failed to fetch"));
    const mutation = new MutationObserver(queryClient, { mutationFn });
    try {
      await expect(mutation.mutate(undefined)).rejects.toThrow(
        "Failed to fetch"
      );
      expect(mutationFn).toHaveBeenCalledTimes(1);
    } finally {
      queryClient.clear();
    }
  });
  it.each([502, 503, 522, 524])(
    "retains HTML HTTP %s through the real tRPC chain and recovers",
    async status => {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(
          new Response("<html>Temporary edge error</html>", { status })
        )
        .mockResolvedValueOnce(
          Response.json([{ result: { data: { id: 17 } } }])
        );
      const client = createTRPCUntypedClient({
        links: [
          httpBatchLink({
            url: "https://sender.example/api/trpc",
            fetch: createRpcFetch({ fetcher }),
          }),
        ],
      });
      const queryClient = new QueryClient();
      try {
        expect(
          await queryClient.fetchQuery({
            queryKey: ["synthetic-edge"],
            queryFn: () => client.query("auth.me"),
            retry: shouldRetryRead,
            retryDelay: 0,
          })
        ).toEqual({ id: 17 });
        expect(fetcher).toHaveBeenCalledTimes(2);
      } finally {
        queryClient.clear();
      }
    }
  );
  it("retains a non-tRPC JSON503 response and its Retry-After through the SDK", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response('{"error":"SERVICE_UNAVAILABLE"}', {
          status: 503,
          headers: { "Retry-After": "120" },
        })
      );
    const client = createTRPCUntypedClient({
      links: [
        httpBatchLink({
          url: "https://sender.example/api/trpc",
          fetch: createRpcFetch({ fetcher }),
        }),
      ],
    });
    try {
      await client.query("auth.me");
      throw new Error("Expected HTTP error");
    } catch (error) {
      expect(isTransientReadError(error)).toBe(true);
      expect(shouldRetryRead(0, error)).toBe(false);
      expect(readRetryDelay(0, error)).toBe(120_000);
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("recovers an empty gateway error response through the actual SDK", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json([{ result: { data: null } }]));
    const client = createTRPCUntypedClient({
      links: [
        httpBatchLink({
          url: "https://sender.example/api/trpc",
          fetch: createRpcFetch({ fetcher }),
        }),
      ],
    });
    const queryClient = new QueryClient();
    try {
      expect(
        await queryClient.fetchQuery({
          queryKey: ["synthetic-empty-gateway"],
          queryFn: () => client.query("auth.me"),
          retry: shouldRetryRead,
          retryDelay: 0,
        })
      ).toBeNull();
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      queryClient.clear();
    }
  });
  it("retains the remaining server wait across focus and reconnect", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-27T08:00:00Z"));
    const error = {
      meta: {
        response: new Response("temporary", {
          status: 503,
          headers: { "Retry-After": "120" },
        }),
      },
    };
    const query = { state: { error, errorUpdatedAt: Date.now() } };
    expect(canRefetchRead(query)).toBe(false);
    expect(sessionQueryOptions.refetchOnWindowFocus(query)).toBe(false);
    expect(sessionQueryOptions.refetchOnReconnect(query)).toBe(false);
    vi.advanceTimersByTime(30_000);
    expect(sessionQueryOptions.refetchInterval(query)).toBe(90_000);
    expect(canRefetchRead(query)).toBe(false);
    vi.advanceTimersByTime(90_001);
    expect(canRefetchRead(query)).toBe(true);
    expect(sessionQueryOptions.refetchInterval(query)).toBe(10_000);
  });
});

describe("single HTTP attempt with a complete response deadline", () => {
  it.each(["GET", "POST"])(
    "makes one %s request with private uncached session credentials",
    async method => {
      const fetcher = vi
        .fn()
        .mockResolvedValue(
          new Response('{"ok":true}', {
            headers: { "Content-Type": "application/json" },
          })
        );
      const request = createRpcFetch({ fetcher });
      expect(
        await (
          await request("https://sender.example/api/trpc/auth.me", { method })
        ).json()
      ).toEqual({ ok: true });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher.mock.calls[0][1]).toMatchObject({
        method,
        credentials: "include",
        cache: "no-store",
      });
    }
  );
  it.each(["GET", "POST"])(
    "does not retry failed %s at the fetch layer",
    async method => {
      const fetcher = vi
        .fn()
        .mockRejectedValue(new TypeError("Failed to fetch"));
      await expect(
        createRpcFetch({ fetcher })("https://sender.example/api/trpc/auth.me", {
          method,
        })
      ).rejects.toThrow("Failed to fetch");
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  );
  it("aborts a stalled read with a retryable timeout and frees its timer", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener(
            "abort",
            () => reject(init!.signal!.reason),
            { once: true }
          );
        })
    );
    const promise = createRpcFetch({ fetcher, readTimeoutMs: 50 })(
      "https://sender.example/api/trpc/auth.me"
    );
    const assertion =
      expect(promise).rejects.toBeInstanceOf(RequestTimeoutError);
    await vi.advanceTimersByTimeAsync(51);
    await assertion;
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps the deadline until the response body finishes downloading", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(
      async (_input, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              init!.signal!.addEventListener(
                "abort",
                () => controller.error(init!.signal!.reason),
                { once: true }
              );
            },
          })
        )
    );
    const promise = createRpcFetch({ fetcher, readTimeoutMs: 50 })(
      "https://sender.example/api/trpc/auth.me"
    );
    const assertion =
      expect(promise).rejects.toBeInstanceOf(RequestTimeoutError);
    await vi.advanceTimersByTimeAsync(51);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });
  it("preserves caller cancellation without turning it into a retryable timeout", async () => {
    const parent = new AbortController();
    const fetcher = vi.fn(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener(
            "abort",
            () => reject(init!.signal!.reason),
            { once: true }
          );
        })
    );
    const promise = createRpcFetch({ fetcher })(
      "https://sender.example/api/trpc/auth.me",
      { signal: parent.signal }
    );
    const assertion = expect(promise).rejects.toMatchObject({
      name: "AbortError",
    });
    parent.abort();
    await assertion;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
