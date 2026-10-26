import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const PREFIX = "enc:v1:";

function encryptionKey(): Buffer {
  const value = process.env.ENCRYPTION_KEY ?? "";
  const key = Buffer.from(value, "base64");
  if (key.length !== 32 || key.toString("base64") !== value) {
    throw new Error(
      "ENCRYPTION_KEY must contain exactly 32 bytes encoded as base64"
    );
  }
  return key;
}

export function isEncryptedSecret(value: string): boolean {
  return value.startsWith(PREFIX);
}

export function encryptSecret(value: string, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(Buffer.from(context));
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return `${PREFIX}${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${encrypted.toString("base64url")}`;
}

export function decryptSecret(value: string, context: string): string {
  if (!isEncryptedSecret(value))
    throw new Error(
      "Legacy unencrypted credential: run the explicit secret migration before use"
    );
  const parts = value.slice(PREFIX.length).split(":");
  if (parts.length !== 3) throw new Error("Invalid encrypted credential");
  try {
    const iv = Buffer.from(parts[0], "base64url");
    const tag = Buffer.from(parts[1], "base64url");
    if (iv.length !== 12 || tag.length !== 16)
      throw new Error("Invalid credential envelope");
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(parts[2], "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error(
      "Cannot decrypt stored credential; check encryption key and restore procedure"
    );
  }
}
