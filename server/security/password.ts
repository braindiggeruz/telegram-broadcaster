import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, 64, PARAMS, (error, key) =>
      error ? reject(error) : resolve(key)
    )
  );
}

export async function hashOwnerPassword(password: string): Promise<string> {
  if (password.length < 12 || password.length > 1024)
    throw new Error("Owner password must have 12 to 1024 characters");
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export function validatePasswordHash(encoded: string): void {
  const [algorithm, n, r, p, salt, hash, extra] = encoded.split("$");
  if (
    algorithm !== "scrypt" ||
    n !== String(PARAMS.N) ||
    r !== String(PARAMS.r) ||
    p !== String(PARAMS.p) ||
    !salt ||
    !hash ||
    extra !== undefined ||
    Buffer.from(salt, "base64url").length !== 16 ||
    Buffer.from(hash, "base64url").length !== 64
  ) {
    throw new Error(
      "OWNER_PASSWORD_HASH must be generated with the setup command"
    );
  }
}

export async function verifyOwnerPassword(
  password: string,
  encoded: string
): Promise<boolean> {
  validatePasswordHash(encoded);
  const [, , , , salt, hash] = encoded.split("$");
  const actual = await derive(password, Buffer.from(salt, "base64url"));
  return timingSafeEqual(actual, Buffer.from(hash, "base64url"));
}
