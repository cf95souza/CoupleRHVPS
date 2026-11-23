import crypto from 'node:crypto';
import { env } from '../../config/env.js';

/**
 * Deriva uma chave de 256 bits (32 bytes) segura via SHA-256
 */
function deriveKey(rawKey?: string): Buffer {
  const secret = rawKey || process.env.MFA_ENCRYPTION_KEY || env.DATA_ENCRYPTION_KEY;
  return crypto.createHash('sha256').update(secret).digest();
}

/**
 * Criptografa texto usando AES-256-GCM (Autenticado, NIST SP 800-38D)
 * Formato retornado: iv_hex:tag_hex:ciphertext_hex
 */
export function encryptAesGcm(plaintext: string, rawKey?: string): string {
  const key = deriveKey(rawKey);
  const iv = crypto.randomBytes(12); // 96 bits recomendado para GCM

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decriptografa texto cifrado com AES-256-GCM e valida integridade via Auth Tag
 */
export function decryptAesGcm(encryptedPayload: string, rawKey?: string): string {
  const parts = encryptedPayload.split(':');
  if (parts.length !== 3) {
    throw new Error('Payload criptográfico inválido.');
  }

  const [ivHex, tagHex, dataHex] = parts;
  const key = deriveKey(rawKey);
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(tagHex, 'hex');
  const encryptedData = Buffer.from(dataHex, 'hex');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  try {
    const decrypted = Buffer.concat([
      decipher.update(encryptedData),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  } catch (err) {
    throw new Error('Falha na decriptação AES-GCM: dados adulterados ou chave incorreta.');
  }
}

/**
 * Gera códigos de recuperação de uso único (Backup Codes)
 * Formato amigável: XXXXX-XXXXX
 */
export function generateRecoveryCodes(count = 8): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase();
    const formatted = `${raw.slice(0, 5)}-${raw.slice(5, 10)}`;
    codes.push(formatted);
  }
  return codes;
}

/**
 * Normaliza e gera hash SHA-256 do código de recuperação para armazenamento seguro
 */
export function hashRecoveryCode(code: string): string {
  const normalized = code.replace(/[-\s]/g, '').toUpperCase().trim();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}
