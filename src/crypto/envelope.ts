import crypto from 'crypto';

const ENVELOPE_REGEX = /^v([0-9]+):([0-9a-fA-F]{24}):([0-9a-fA-F]{32}):([0-9a-fA-F]+)$/;

export interface EnvelopeContext {
  tenantId: number;
  courierCode: string;
}

/**
 * Encrypts a credential using AES-256-GCM (12-byte IV = 24 hex chars, 16-byte Tag = 32 hex chars)
 * and binds {tenantId}:{courierCode} as Additional Authenticated Data (AAD) to prevent
 * cross-tenant ciphertext transplant attacks.
 */
export function encryptCredential(
  plaintext: string,
  keyHex: string,
  keyVersion: number,
  ctx: EnvelopeContext
): string {
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) {
    throw new Error('AES-256-GCM key must be exactly 32 bytes (64 hex characters)');
  }

  const iv = crypto.randomBytes(12); // 12 bytes = 24 hex chars (NIST SP 800-38D standard)
  const aad = Buffer.from(`${ctx.tenantId}:${ctx.courierCode}`, 'utf8');

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag(); // 16 bytes = 32 hex chars

  return `v${keyVersion}:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypts and authenticates an AES-256-GCM envelope string using the tenant/courier AAD.
 */
export function decryptCredential(
  envelope: string,
  keyLookup: (version: number) => string,
  ctx: EnvelopeContext
): string {
  const match = envelope.match(ENVELOPE_REGEX);
  if (!match) {
    throw new Error('Invalid cryptographic envelope format');
  }

  const keyVersion = parseInt(match[1], 10);
  const iv = Buffer.from(match[2], 'hex');
  const authTag = Buffer.from(match[3], 'hex');
  const ciphertext = Buffer.from(match[4], 'hex');

  const key = Buffer.from(keyLookup(keyVersion), 'hex');
  const aad = Buffer.from(`${ctx.tenantId}:${ctx.courierCode}`, 'utf8');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}
