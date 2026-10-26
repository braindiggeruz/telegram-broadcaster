import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import {
  readAuthenticatedUser,
  type AuthenticatedUser,
} from "../security/sessions";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: AuthenticatedUser | null;
};

export async function createContext(
  opts: CreateExpressContextOptions
): Promise<TrpcContext> {
  return {
    req: opts.req,
    res: opts.res,
    user: await readAuthenticatedUser(opts.req),
  };
}
