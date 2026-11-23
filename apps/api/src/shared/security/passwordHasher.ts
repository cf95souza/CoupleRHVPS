import argon2 from 'argon2';

/**
 * Utilitário de Hashing Criptográfico com Argon2id
 * Algoritmo vencedor do Password Hashing Competition (PHC), resistente a ataques GPU/ASIC
 */
export async function hashPassword(plainPassword: string): Promise<string> {
  return argon2.hash(plainPassword, {
    type: argon2.argon2id,
    memoryCost: 65536, // 64 MB
    timeCost: 3,       // 3 iterações
    parallelism: 2,    // 2 threads concorrentes
  });
}

/**
 * Verifica se uma senha em texto claro corresponde ao hash Argon2id
 */
export async function verifyPassword(plainPassword: string, hash: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plainPassword);
  } catch {
    return false;
  }
}

/**
 * Normaliza um CPF removendo pontos, traços e espaços, mantendo apenas os 11 dígitos
 */
export function normalizeCpf(rawCpf: string): string {
  if (!rawCpf) return '';
  return rawCpf.replace(/\D/g, '').trim();
}

/**
 * Normaliza formatos diversos de data de nascimento para o padrão ISO 'YYYY-MM-DD'
 * Suporta:
 * - 'DDMMAAAA' (ex: '25081990')
 * - 'DD/MM/AAAA' (ex: '25/08/1990')
 * - 'DD-MM-AAAA' (ex: '25-08-1990')
 * - 'YYYY-MM-DD' (ex: '1990-08-25')
 */
export function normalizeBirthDate(rawDate: string): string | null {
  if (!rawDate) return null;
  const clean = rawDate.trim();

  // Caso 1: YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
    return clean;
  }

  // Caso 2: DD/MM/AAAA ou DD-MM-AAAA
  const slashMatch = clean.match(/^(\d{2})[/.-](\d{2})[/.-](\d{4})$/);
  if (slashMatch) {
    const [, day, month, year] = slashMatch;
    return `${year}-${month}-${day}`;
  }

  // Caso 3: DDMMAAAA (apenas 8 dígitos)
  const digits = clean.replace(/\D/g, '');
  if (digits.length === 8) {
    const day = digits.substring(0, 2);
    const month = digits.substring(2, 4);
    const year = digits.substring(4, 8);
    return `${year}-${month}-${day}`;
  }

  return null;
}
