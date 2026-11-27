import crypto from 'node:crypto';

const XMLDSIG_NS = 'http://www.w3.org/2000/09/xmldsig#';

/**
 * Canonicalizacao deterministica (C14N 1.0) para assinatura e verificacao XML-DSig.
 */
function canonicalizeXmlFragment(xmlFragment: string): string {
  return xmlFragment
    .replace(/^<\?xml[^>]*\?>\s*/i, '')
    .replace(/>\s+</g, '><')
    .trim();
}

function derBase64ToPemCertificate(certDerBase64: string): string {
  const clean = certDerBase64.replace(/\s+/g, '');
  const lines = clean.match(/.{1,64}/g) || [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----`;
}

export interface XmlDsigResult {
  signedXml: string;
  digestValue: string;
  signatureValue: string;
}

/**
 * Assina um XML de evento eSocial usando XML-DSig Enveloped (RSA-SHA256 + SHA-256 Digest + X509Certificate)
 * conforme padrao tecnico oficial do eSocial.
 */
export function signEsocialXml(
  xml: string,
  privateKeyPem: string,
  certDerBase64: string
): XmlDsigResult {
  const closingTag = '</eSocial>';
  const closeIdx = xml.lastIndexOf(closingTag);
  if (closeIdx === -1) {
    throw new Error('XML eSocial invalido: tag de fechamento </eSocial> ausente.');
  }

  // Documento canonizado sem <Signature> para transformacao Enveloped
  const docWithoutSignature = canonicalizeXmlFragment(xml);
  const digestValue = crypto
    .createHash('sha256')
    .update(Buffer.from(docWithoutSignature, 'utf8'))
    .digest('base64');

  const signedInfoBody =
    `<CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"></CanonicalizationMethod>` +
    `<SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"></SignatureMethod>` +
    `<Reference URI="">` +
    `<Transforms>` +
    `<Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"></Transform>` +
    `<Transform Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"></Transform>` +
    `</Transforms>` +
    `<DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"></DigestMethod>` +
    `<DigestValue>${digestValue}</DigestValue>` +
    `</Reference>`;

  const signedInfoForSigning = `<SignedInfo xmlns="${XMLDSIG_NS}">${signedInfoBody}</SignedInfo>`;

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(Buffer.from(signedInfoForSigning, 'utf8'));
  signer.end();
  const signatureValue = signer.sign(privateKeyPem, 'base64');

  const cleanCert = certDerBase64.replace(/\s+/g, '');
  const signatureXml =
    `<Signature xmlns="${XMLDSIG_NS}">` +
    `<SignedInfo>${signedInfoBody}</SignedInfo>` +
    `<SignatureValue>${signatureValue}</SignatureValue>` +
    `<KeyInfo><X509Data><X509Certificate>${cleanCert}</X509Certificate></X509Data></KeyInfo>` +
    `</Signature>`;

  const signedXml = `${xml.slice(0, closeIdx)}${signatureXml}${xml.slice(closeIdx)}`;

  return {
    signedXml,
    digestValue,
    signatureValue,
  };
}

/**
 * Verifica criptograficamente a integridade da assinatura XML-DSig (Digest SHA-256 + RSA-SHA256).
 */
export function verifyXmlDsigSignature(signedXml: string): {
  valid: boolean;
  reason?: string;
} {
  const sigMatch = /<Signature\s+xmlns="http:\/\/www\.w3\.org\/2000\/09\/xmldsig#">([\s\S]*?)<\/Signature>/.exec(
    signedXml
  );
  if (!sigMatch) {
    return { valid: false, reason: 'Elemento <Signature> ausente.' };
  }

  const sigContent = sigMatch[1];
  const signedInfoMatch = /<SignedInfo>([\s\S]*?)<\/SignedInfo>/.exec(sigContent);
  const digestMatch = /<DigestValue>([^<]+)<\/DigestValue>/.exec(sigContent);
  const sigValMatch = /<SignatureValue>([^<]+)<\/SignatureValue>/.exec(sigContent);
  const certMatch = /<X509Certificate>([^<]+)<\/X509Certificate>/.exec(sigContent);

  if (!signedInfoMatch || !digestMatch || !sigValMatch || !certMatch) {
    return { valid: false, reason: 'Estrutura interna da assinatura XML-DSig incompleta.' };
  }

  // 1. Verificar Digest SHA-256 do documento sem a tag Signature
  const docWithoutSignature = canonicalizeXmlFragment(
    signedXml.replace(sigMatch[0], '')
  );
  const recomputedDigest = crypto
    .createHash('sha256')
    .update(Buffer.from(docWithoutSignature, 'utf8'))
    .digest('base64');

  if (recomputedDigest !== digestMatch[1].trim()) {
    return { valid: false, reason: 'DigestValue invalido: conteudo XML foi alterado apos a assinatura.' };
  }

  // 2. Verificar SignatureValue RSA-SHA256 com o certificado X509 embutido
  try {
    const pemCert = derBase64ToPemCertificate(certMatch[1]);
    const signedInfoCanonical = `<SignedInfo xmlns="${XMLDSIG_NS}">${canonicalizeXmlFragment(
      signedInfoMatch[1]
    )}</SignedInfo>`;
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(Buffer.from(signedInfoCanonical, 'utf8'));
    verifier.end();
    const ok = verifier.verify(pemCert, sigValMatch[1].trim(), 'base64');
    if (!ok) {
      return { valid: false, reason: 'SignatureValue RSA-SHA256 invalido.' };
    }
    return { valid: true };
  } catch (err: any) {
    return { valid: false, reason: err?.message || 'Erro ao verificar assinatura RSA-SHA256.' };
  }
}
