import crypto from 'crypto';

function base64UrlEncode(input: string | Buffer): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf-8');
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64UrlDecode(input: string): string {
  let base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  return Buffer.from(base64, 'base64').toString('utf-8');
}

/**
 * Assina um JWT HMAC-SHA256 (HS256) em conformidade estrita com a RFC 7519
 */
export function signJwt(payload: Record<string, any>, secret: string, expiresInSeconds: number): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);

  const fullPayload = {
    ...payload,
    iat: now,
    exp: now + expiresInSeconds,
  };

  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(fullPayload));
  const data = `${headerB64}.${payloadB64}`;

  const signature = crypto.createHmac('sha256', secret).update(data).digest();
  const signatureB64 = base64UrlEncode(signature);

  return `${data}.${signatureB64}`;
}

/**
 * Verifica e decodifica um JWT HMAC-SHA256 com proteção contra timing attacks
 */
export function verifyJwt<T = any>(token: string, secret: string): T {
  if (!token || typeof token !== 'string') {
    throw new Error('Token não fornecido ou inválido.');
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Formato de token JWT inválido.');
  }

  const [headerB64, payloadB64, signatureB64] = parts;
  const data = `${headerB64}.${payloadB64}`;

  const expectedSignature = crypto.createHmac('sha256', secret).update(data).digest();
  const expectedSignatureB64 = base64UrlEncode(expectedSignature);

  // Compara em tempo constante para mitigar timing attacks
  const sigBuf = Buffer.from(signatureB64);
  const expectedBuf = Buffer.from(expectedSignatureB64);

  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    throw new Error('Assinatura do token de acesso inválida.');
  }

  let decodedPayload: any;
  try {
    decodedPayload = JSON.parse(base64UrlDecode(payloadB64));
  } catch {
    throw new Error('Payload do token corrompido.');
  }

  const now = Math.floor(Date.now() / 1000);
  if (decodedPayload.exp && decodedPayload.exp < now) {
    throw new Error('Token de acesso expirado.');
  }

  return decodedPayload as T;
}
