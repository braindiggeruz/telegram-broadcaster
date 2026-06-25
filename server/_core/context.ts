import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";

// Standalone mode: fixed user with id=1, no OAuth required.
const STANDALONE_USER = {
  id: 1,
  openId: "standalone",
  name: "Admin",
  email: null as string | null,
  role: "admin" as const,
  loginMethod: null as string | null,
  lastSignedIn: new Date(),
  createdAt: new Date(),
};

export type StandaloneUser = typeof STANDALONE_USER;

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: StandaloneUser;
};

export async function createContext(
  opts: CreateExpressContextOptions
): Promise<TrpcContext> {
  return {
    req: opts.req,
    res: opts.res,
    user: STANDALONE_USER,
  };
}
