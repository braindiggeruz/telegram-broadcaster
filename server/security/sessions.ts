import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { parse } from "cookie";
import type { Request } from "express";
import { COOKIE_NAME } from "../../shared/const";
import type { User } from "../../drizzle/schema";
import { getPool } from "../connection";

export type AuthenticatedUser = Omit<User, "updatedAt">;
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export function sessionSecret(): string {
  const secret = process.env.SESSION_SECRET ?? "";
  if (secret.length < 32)
    throw new Error(
      "SESSION_SECRET must contain at least 32 random characters"
    );
  return secret;
}

function signature(payload: string): string {
  // Changing the owner password invalidates previously signed cookies.
  return createHmac("sha256", sessionSecret())
    .update(`${process.env.OWNER_PASSWORD_HASH ?? ""}\0${payload}`)
    .digest("base64url");
}

export function signSessionToken(id: string, expiresAt: number): string {
  const payload = `v1.${id}.${expiresAt}`;
  return `${payload}.${signature(payload)}`;
}

export function verifySessionToken(
  token: string,
  now = Date.now()
): { hash: string; expiresAt: number } | null {
  if (token.length > 256) return null;
  const match = /^v1\.([A-Za-z0-9_-]{43})\.(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(
    token
  );
  if (!match) return null;
  const expiresAt = Number(match[2]);
  if (
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= now ||
    expiresAt > now + SESSION_TTL_MS + 60_000
  )
    return null;
  const payload = token.slice(0, token.lastIndexOf("."));
  const expected = Buffer.from(signature(payload));
  const actual = Buffer.from(match[3]);
  if (!timingSafeEqual(actual, expected)) return null;
  return {
    hash: createHash("sha256").update(match[1]).digest("hex"),
    expiresAt,
  };
}

export function requestSessionToken(
  req: Pick<Request, "headers">
): string | undefined {
  try {
    return parse(req.headers.cookie ?? "")[COOKIE_NAME];
  } catch {
    return undefined;
  }
}

export async function readAuthenticatedUser(
  req: Pick<Request, "headers">
): Promise<AuthenticatedUser | null> {
  const token = requestSessionToken(req);
  if (!token) return null;
  const verified = verifySessionToken(token);
  if (!verified) return null;
  const result = await getPool().query<AuthenticatedUser>(
    `SELECT u.id, u."openId", u.name, u.email, u.role, u."loginMethod", u."createdAt", u."lastSignedIn"
     FROM auth_sessions s JOIN users u ON u.id=s.user_id
     WHERE s.session_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now()
       AND u."openId"=$2 AND u.role='admin'`,
    [verified.hash, process.env.OWNER_OPEN_ID || "local-owner"]
  );
  return result.rows[0] ?? null;
}

export async function createOwnerSession(): Promise<{
  user: AuthenticatedUser;
  token: string;
}> {
  const pool = getPool();
  const owner = await pool.query<AuthenticatedUser>(
    `INSERT INTO users ("openId",name,role,"loginMethod","lastSignedIn") VALUES ($1,$2,'admin','password',now())
     ON CONFLICT ("openId") DO UPDATE SET role='admin',"lastSignedIn"=now(),"updatedAt"=now()
     RETURNING id,"openId",name,email,role,"loginMethod","createdAt","lastSignedIn"`,
    [
      process.env.OWNER_OPEN_ID || "local-owner",
      process.env.OWNER_NAME || "Владелец",
    ]
  );
  const user = owner.rows[0];
  const id = randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + SESSION_TTL_MS;
  await pool.query(
    `INSERT INTO auth_sessions (session_hash,user_id,expires_at) VALUES ($1,$2,$3)`,
    [
      createHash("sha256").update(id).digest("hex"),
      user.id,
      new Date(expiresAt),
    ]
  );
  await pool.query(
    `DELETE FROM auth_sessions WHERE expires_at < now() - interval '1 day'`
  );
  return { user, token: signSessionToken(id, expiresAt) };
}

export async function revokeRequestSession(
  req: Pick<Request, "headers">
): Promise<void> {
  const token = requestSessionToken(req);
  const verified = token ? verifySessionToken(token) : null;
  if (verified)
    await getPool().query(
      `UPDATE auth_sessions SET revoked_at=now() WHERE session_hash=$1`,
      [verified.hash]
    );
}

export async function consumeLoginAttempt(ip: string): Promise<boolean> {
  const key = createHmac("sha256", sessionSecret()).update(ip).digest("hex");
  const result = await getPool().query<{ attempts: number }>(
    `INSERT INTO auth_login_attempts (bucket_key,attempts,window_started_at) VALUES ($1,1,now())
     ON CONFLICT (bucket_key) DO UPDATE SET
       attempts=CASE WHEN auth_login_attempts.window_started_at < now()-interval '15 minutes' THEN 1 ELSE auth_login_attempts.attempts+1 END,
       window_started_at=CASE WHEN auth_login_attempts.window_started_at < now()-interval '15 minutes' THEN now() ELSE auth_login_attempts.window_started_at END
     RETURNING attempts`,
    [key]
  );
  return result.rows[0].attempts <= 5;
}

export async function clearLoginAttempts(ip: string): Promise<void> {
  const key = createHmac("sha256", sessionSecret()).update(ip).digest("hex");
  await getPool().query(
    `DELETE FROM auth_login_attempts WHERE bucket_key=$1 OR window_started_at < now()-interval '1 day'`,
    [key]
  );
}
