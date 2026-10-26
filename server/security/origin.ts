import type { Request } from "express";
import { TRPCError } from "@trpc/server";

export function appOrigin(): string {
  let url: URL;
  try {
    url = new URL(process.env.APP_ORIGIN ?? "");
  } catch {
    throw new Error("APP_ORIGIN must be configured");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("APP_ORIGIN must be an HTTP(S) origin without a path");
  if (
    url.protocol === "http:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  )
    throw new Error("APP_ORIGIN must use HTTPS except on loopback");
  return url.origin;
}

export function assertSameOrigin(req: Pick<Request, "headers">): void {
  if (
    req.headers.origin !== appOrigin() ||
    req.headers["sec-fetch-site"] === "cross-site"
  ) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Request origin is not allowed",
    });
  }
}
