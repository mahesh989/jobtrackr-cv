/**
 * AES-256-GCM encryption/decryption for integration API keys.
 *
 * Keys are encrypted before being stored in user_integrations.encrypted_api_key.
 * The raw key never touches the database in plaintext.
 *
 * Format stored in DB: base64( iv[16 bytes] | authTag[16 bytes] | ciphertext )
 *
 * Requires env var:
 *   INTEGRATION_ENCRYPTION_KEY = 64 hex chars (32 bytes)
 *   Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LEN    = 16;
const TAG_LEN   = 16;

function getKey(): Buffer {
  const hex = process.env.INTEGRATION_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      "INTEGRATION_ENCRYPTION_KEY must be a 64-char hex string (32 bytes). " +
      "Generate: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }
  return Buffer.from(hex, "hex");
}

/**
 * Encrypt a plaintext API key. Returns a base64 blob safe to store in Postgres.
 */
export function encryptApiKey(plaintext: string): string {
  const key    = getKey();
  const iv     = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Pack: iv | authTag | ciphertext → base64
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

/**
 * Decrypt a stored blob back to the plaintext API key.
 * Throws if the blob is tampered (GCM auth tag mismatch).
 */
export function decryptApiKey(stored: string): string {
  const key = getKey();
  const buf = Buffer.from(stored, "base64");

  if (buf.length < IV_LEN + TAG_LEN + 1) {
    throw new Error("Encrypted blob is too short — corrupted or truncated");
  }

  const iv        = buf.subarray(0, IV_LEN);
  const authTag   = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const encrypted = buf.subarray(IV_LEN + TAG_LEN);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString("utf8");
}
