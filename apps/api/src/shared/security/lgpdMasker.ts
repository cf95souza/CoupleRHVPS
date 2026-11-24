/**
 * Funções de Sanitização e Mascaramento LGPD (Lei 13.709/2018) & Resolução CFM 1.851/2008.
 * Executadas estritamente no servidor antes da serialização HTTP.
 */

/**
 * Mascara CPF no formato: ***.XXX.XXX-** (preserva dígitos intermediários para identificação visual)
 */
export function maskCpf(cpf: string | null | undefined): string | null {
  if (!cpf) return null;
  const clean = cpf.replace(/\D/g, '');
  if (clean.length !== 11) return '***.***.***-**';
  return `***.${clean.substring(3, 6)}.${clean.substring(6, 9)}-**`;
}

/**
 * Mascara PIS/PASEP no formato: ***.*****.**-*
 */
export function maskPis(pis: string | null | undefined): string | null {
  if (!pis) return null;
  const clean = pis.replace(/\D/g, '');
  if (clean.length < 10) return '***.*****.**-*';
  const last2 = clean.slice(-2);
  return `***.*****.${last2[0]}-${last2[1]}`;
}

/**
 * Mascara Chave PIX: oculta dados sensíveis (e-mail, telefone, CPF ou EVP)
 */
export function maskPixKey(key: string | null | undefined): string | null {
  if (!key) return null;
  const trimmed = key.trim();
  if (trimmed.length <= 4) return '***';
  return `${trimmed.substring(0, 2)}***${trimmed.substring(trimmed.length - 2)}`;
}

/**
 * Mascara Agência e Conta Bancária
 */
export function maskBankData(account: string | null | undefined, agency: string | null | undefined) {
  return {
    agency: agency ? `***-${agency.slice(-1)}` : null,
    account: account ? `*****-${account.slice(-1)}` : null,
  };
}

/**
 * Supressão estrita de CID-10 e notas clínicas em conformidade com a Resolução CFM 1.851/2008
 */
export function maskMedicalCid(): null {
  return null;
}
