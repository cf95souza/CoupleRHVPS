import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

export interface MtlsRequestResult {
  httpStatus: number;
  responseXml: string;
}

export interface ParsedSendBatchResponse {
  cdResposta: string;
  descResposta: string;
  protocolNumber: string | null;
  ocorrencias: Array<{ codigo: string; descricao: string; tipo: string }>;
}

export interface ParsedPollEventResult {
  eventId: string;
  cdResposta: string;
  descResposta: string;
  receiptNumber: string | null;
  receiptXml: string | null;
  ocorrencias: Array<{ codigo: string; descricao: string; tipo: string }>;
  totalizerXmls: string[];
}

export interface ParsedPollBatchResponse {
  cdResposta: string;
  descResposta: string;
  events: ParsedPollEventResult[];
}

function extractTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?>([^<]*)</(?:[\\w-]+:)?${tag}>`);
  const match = re.exec(xml);
  return match ? match[1].trim() : null;
}

function extractOcorrencias(xml: string): Array<{ codigo: string; descricao: string; tipo: string }> {
  const list: Array<{ codigo: string; descricao: string; tipo: string }> = [];
  const re = /<(?:[\w-]+:)?ocorrencia(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w-]+:)?ocorrencia>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    const block = match[1];
    list.push({
      codigo: extractTag(block, 'codigo') || '',
      descricao: extractTag(block, 'descricao') || '',
      tipo: extractTag(block, 'tipo') || '1',
    });
  }
  return list;
}

function extractTotalizerXmls(block: string): string[] {
  const xmls: string[] = [];
  const totRe = /<(?:[\w-]+:)?tot(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w-]+:)?tot>/g;
  let match: RegExpExecArray | null;
  while ((match = totRe.exec(block)) !== null) {
    const inner = match[1].trim();
    if (inner.includes('<eSocial')) {
      xmls.push(inner);
    }
  }
  return xmls;
}

/**
 * Executa requisicao SOAP 1.1 sobre HTTPS mTLS com o certificado digital A1 (ICP-Brasil).
 */
export async function postSoapWithMtls(params: {
  endpointUrl: string;
  soapAction: string;
  xmlBody: string;
  certPem: string;
  keyPem: string;
  rejectUnauthorized?: boolean;
  timeoutMs?: number;
}): Promise<MtlsRequestResult> {
  const parsedUrl = new URL(params.endpointUrl);
  const bodyBuffer = Buffer.from(params.xmlBody, 'utf8');

  const isHttps = parsedUrl.protocol === 'https:';
  const agent = isHttps
    ? new https.Agent({
        cert: params.certPem,
        key: params.keyPem,
        minVersion: 'TLSv1.2',
        rejectUnauthorized: params.rejectUnauthorized ?? true,
        keepAlive: false,
      })
    : undefined;

  return new Promise<MtlsRequestResult>((resolve, reject) => {
    const transport = isHttps ? https : http;
    const req = transport.request(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port ? Number(parsedUrl.port) : isHttps ? 443 : 80,
        path: `${parsedUrl.pathname}${parsedUrl.search}`,
        method: 'POST',
        agent,
        timeout: params.timeoutMs ?? 20000,
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          'Content-Length': bodyBuffer.length,
          SOAPAction: params.soapAction,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on('end', () => {
          resolve({
            httpStatus: res.statusCode ?? 500,
            responseXml: Buffer.concat(chunks).toString('utf8'),
          });
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error('Timeout na comunicacao mTLS com webservice eSocial.'));
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.write(bodyBuffer);
    req.end();
  });
}

export function parseSendBatchResponse(responseXml: string): ParsedSendBatchResponse {
  return {
    cdResposta: extractTag(responseXml, 'cdResposta') || '999',
    descResposta: extractTag(responseXml, 'descResposta') || 'Resposta nao identificada',
    protocolNumber: extractTag(responseXml, 'protocoloEnvio'),
    ocorrencias: extractOcorrencias(responseXml),
  };
}

export function parsePollBatchResponse(responseXml: string): ParsedPollBatchResponse {
  const statusBlock =
    /<(?:[\w-]+:)?status>([\s\S]*?)<\/(?:[\w-]+:)?status>/.exec(responseXml)?.[1] || responseXml;
  const cdResposta = extractTag(statusBlock, 'cdResposta') || '999';
  const descResposta = extractTag(statusBlock, 'descResposta') || 'Status nao identificado';

  const events: ParsedPollEventResult[] = [];
  const evRe = /<(?:[\w-]+:)?evento\s+Id="([^"]+)"[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?evento>/g;
  let match: RegExpExecArray | null;
  while ((match = evRe.exec(responseXml)) !== null) {
    const eventId = match[1];
    const block = match[2];
    const procBlock =
      /<(?:[\w-]+:)?processamento>([\s\S]*?)<\/(?:[\w-]+:)?processamento>/.exec(block)?.[1] || block;
    const recBlock =
      /<(?:[\w-]+:)?recibo>([\s\S]*?)<\/(?:[\w-]+:)?recibo>/.exec(block)?.[0] || null;

    events.push({
      eventId,
      cdResposta: extractTag(procBlock, 'cdResposta') || '999',
      descResposta: extractTag(procBlock, 'descResposta') || '',
      receiptNumber: extractTag(block, 'nrRecibo'),
      receiptXml: recBlock,
      ocorrencias: extractOcorrencias(procBlock),
      totalizerXmls: extractTotalizerXmls(block),
    });
  }

  return {
    cdResposta,
    descResposta,
    events,
  };
}
