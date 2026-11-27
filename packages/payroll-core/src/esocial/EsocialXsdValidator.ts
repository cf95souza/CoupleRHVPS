import { getEsocialNamespace, getEsocialRootTag } from './EsocialXmlGenerator.js';
import type {
  EsocialLayoutVersion,
  EsocialOutboundEventType,
  EsocialValidationError,
  EsocialValidationResult,
} from './EsocialTypes.js';

interface EventSchemaSpec {
  requiredTags: string[];
  tagPatterns?: Array<{ tag: string; regex: RegExp; message: string }>;
}

const DATE_YYYY_MM_DD = /^\d{4}-\d{2}-\d{2}$/;
const PERIOD_YYYY_MM = /^\d{4}-(0[1-9]|1[0-2])$/;
const PERIOD_YYYY_OR_MM = /^\d{4}(-(0[1-9]|1[0-2]))?$/;
const CPF_11 = /^\d{11}$/;
const DECIMAL_2 = /^\d+\.\d{2}$/;

const EVENT_SPECS: Record<EsocialOutboundEventType, EventSchemaSpec> = {
  'S-1000': {
    requiredTags: ['ideEvento', 'ideEmpregador', 'infoEmpregador', 'iniValid', 'classTrib'],
    tagPatterns: [{ tag: 'iniValid', regex: PERIOD_YYYY_MM, message: 'iniValid deve seguir YYYY-MM.' }],
  },
  'S-1005': {
    requiredTags: ['ideEvento', 'ideEmpregador', 'infoEstab', 'cnaePrep', 'aliqRat', 'fap'],
    tagPatterns: [
      { tag: 'iniValid', regex: PERIOD_YYYY_MM, message: 'iniValid deve seguir YYYY-MM.' },
      { tag: 'aliqRat', regex: /^[123]$/, message: 'aliqRat deve ser 1, 2 ou 3.' },
    ],
  },
  'S-1010': {
    requiredTags: [
      'ideEvento',
      'ideEmpregador',
      'infoRubrica',
      'codRubr',
      'dscRubr',
      'natRubr',
      'tpRubr',
      'codIncCP',
      'codIncIRRF',
      'codIncFGTS',
    ],
    tagPatterns: [{ tag: 'tpRubr', regex: /^[1234]$/, message: 'tpRubr deve ser 1, 2, 3 ou 4.' }],
  },
  'S-1020': {
    requiredTags: ['ideEvento', 'ideEmpregador', 'infoLotacao', 'codLotacao', 'tpLotacao', 'fpas', 'codTercs'],
    tagPatterns: [{ tag: 'iniValid', regex: PERIOD_YYYY_MM, message: 'iniValid deve seguir YYYY-MM.' }],
  },
  'S-2190': {
    requiredTags: ['ideEvento', 'ideEmpregador', 'infoRegPrelim', 'cpfTrab', 'dtNascto', 'dtAdm', 'matricula', 'codCateg', 'vrSalFx'],
    tagPatterns: [
      { tag: 'cpfTrab', regex: CPF_11, message: 'cpfTrab deve conter 11 digitos.' },
      { tag: 'dtAdm', regex: DATE_YYYY_MM_DD, message: 'dtAdm deve seguir YYYY-MM-DD.' },
      { tag: 'vrSalFx', regex: DECIMAL_2, message: 'vrSalFx deve conter 2 casas decimais.' },
    ],
  },
  'S-2200': {
    requiredTags: [
      'ideEvento',
      'ideEmpregador',
      'trabalhador',
      'cpfTrab',
      'nmTrab',
      'dtNascto',
      'vinculo',
      'matricula',
      'dtAdm',
      'codCateg',
      'CBOCargo',
      'vrSalFx',
    ],
    tagPatterns: [
      { tag: 'cpfTrab', regex: CPF_11, message: 'cpfTrab deve conter 11 digitos.' },
      { tag: 'dtNascto', regex: DATE_YYYY_MM_DD, message: 'dtNascto deve seguir YYYY-MM-DD.' },
      { tag: 'dtAdm', regex: DATE_YYYY_MM_DD, message: 'dtAdm deve seguir YYYY-MM-DD.' },
      { tag: 'vrSalFx', regex: DECIMAL_2, message: 'vrSalFx deve conter 2 casas decimais.' },
    ],
  },
  'S-2205': {
    requiredTags: ['ideEvento', 'ideEmpregador', 'ideTrabalhador', 'cpfTrab', 'dtAlteracao', 'nmTrab'],
    tagPatterns: [
      { tag: 'cpfTrab', regex: CPF_11, message: 'cpfTrab deve conter 11 digitos.' },
      { tag: 'dtAlteracao', regex: DATE_YYYY_MM_DD, message: 'dtAlteracao deve seguir YYYY-MM-DD.' },
    ],
  },
  'S-2206': {
    requiredTags: ['ideEvento', 'ideEmpregador', 'ideVinculo', 'cpfTrab', 'matricula', 'dtAlteracao', 'vrSalFx'],
    tagPatterns: [
      { tag: 'cpfTrab', regex: CPF_11, message: 'cpfTrab deve conter 11 digitos.' },
      { tag: 'dtAlteracao', regex: DATE_YYYY_MM_DD, message: 'dtAlteracao deve seguir YYYY-MM-DD.' },
      { tag: 'vrSalFx', regex: DECIMAL_2, message: 'vrSalFx deve conter 2 casas decimais.' },
    ],
  },
  'S-2230': {
    requiredTags: ['ideEvento', 'ideEmpregador', 'ideVinculo', 'cpfTrab', 'matricula', 'dtIniAfast', 'codMotAfast'],
    tagPatterns: [
      { tag: 'cpfTrab', regex: CPF_11, message: 'cpfTrab deve conter 11 digitos.' },
      { tag: 'dtIniAfast', regex: DATE_YYYY_MM_DD, message: 'dtIniAfast deve seguir YYYY-MM-DD.' },
    ],
  },
  'S-2240': {
    requiredTags: ['ideEvento', 'ideEmpregador', 'ideVinculo', 'cpfTrab', 'matricula', 'dtIniCondicao', 'codAgNoc'],
    tagPatterns: [
      { tag: 'cpfTrab', regex: CPF_11, message: 'cpfTrab deve conter 11 digitos.' },
      { tag: 'dtIniCondicao', regex: DATE_YYYY_MM_DD, message: 'dtIniCondicao deve seguir YYYY-MM-DD.' },
    ],
  },
  'S-2299': {
    requiredTags: ['ideEvento', 'ideEmpregador', 'ideVinculo', 'cpfTrab', 'matricula', 'mtvDeslig', 'dtDeslig', 'indPagtoAPI'],
    tagPatterns: [
      { tag: 'cpfTrab', regex: CPF_11, message: 'cpfTrab deve conter 11 digitos.' },
      { tag: 'dtDeslig', regex: DATE_YYYY_MM_DD, message: 'dtDeslig deve seguir YYYY-MM-DD.' },
    ],
  },
  'S-2300': {
    requiredTags: ['ideEvento', 'ideEmpregador', 'trabalhador', 'cpfTrab', 'nmTrab', 'infoTSVInicio', 'codCateg', 'dtInicio'],
    tagPatterns: [
      { tag: 'cpfTrab', regex: CPF_11, message: 'cpfTrab deve conter 11 digitos.' },
      { tag: 'dtInicio', regex: DATE_YYYY_MM_DD, message: 'dtInicio deve seguir YYYY-MM-DD.' },
    ],
  },
  'S-2399': {
    requiredTags: ['ideEvento', 'ideEmpregador', 'ideTrabSemVinculo', 'cpfTrab', 'codCateg', 'dtTerm'],
    tagPatterns: [
      { tag: 'cpfTrab', regex: CPF_11, message: 'cpfTrab deve conter 11 digitos.' },
      { tag: 'dtTerm', regex: DATE_YYYY_MM_DD, message: 'dtTerm deve seguir YYYY-MM-DD.' },
    ],
  },
  'S-1200': {
    requiredTags: ['ideEvento', 'ideEmpregador', 'indApuracao', 'perApur', 'cpfTrab', 'ideDmDev', 'codCateg', 'itensRemun', 'vrRubr'],
    tagPatterns: [
      { tag: 'cpfTrab', regex: CPF_11, message: 'cpfTrab deve conter 11 digitos.' },
      { tag: 'perApur', regex: PERIOD_YYYY_OR_MM, message: 'perApur deve seguir YYYY-MM ou YYYY.' },
      { tag: 'vrRubr', regex: DECIMAL_2, message: 'vrRubr deve conter 2 casas decimais.' },
    ],
  },
  'S-1210': {
    requiredTags: ['ideEvento', 'ideEmpregador', 'perApur', 'cpfBenef', 'dtPgto', 'tpPgto', 'vrLiq'],
    tagPatterns: [
      { tag: 'cpfBenef', regex: CPF_11, message: 'cpfBenef deve conter 11 digitos.' },
      { tag: 'dtPgto', regex: DATE_YYYY_MM_DD, message: 'dtPgto deve seguir YYYY-MM-DD.' },
      { tag: 'vrLiq', regex: DECIMAL_2, message: 'vrLiq deve conter 2 casas decimais.' },
    ],
  },
  'S-1298': {
    requiredTags: ['ideEvento', 'ideEmpregador', 'indApuracao', 'perApur'],
    tagPatterns: [{ tag: 'perApur', regex: PERIOD_YYYY_OR_MM, message: 'perApur deve seguir YYYY-MM ou YYYY.' }],
  },
  'S-1299': {
    requiredTags: ['ideEvento', 'ideEmpregador', 'indApuracao', 'perApur', 'infoFech', 'evtRemun', 'evtPgtos'],
    tagPatterns: [
      { tag: 'perApur', regex: PERIOD_YYYY_OR_MM, message: 'perApur deve seguir YYYY-MM ou YYYY.' },
      { tag: 'evtRemun', regex: /^[SN]$/, message: 'evtRemun deve ser S ou N.' },
      { tag: 'evtPgtos', regex: /^[SN]$/, message: 'evtPgtos deve ser S ou N.' },
    ],
  },
};

function extractTagValue(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`);
  const match = re.exec(xml);
  return match ? match[1].trim() : null;
}

function hasTag(xml: string, tag: string): boolean {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?</${tag}>`);
  return re.test(xml);
}

/**
 * Verifica balanceamento sintatico estrito das tags XML
 */
function checkWellFormedXml(xml: string): string | null {
  const stripped = xml
    .replace(/<\?xml[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();

  if (!stripped.startsWith('<')) {
    return 'Documento XML nao inicia com elemento raiz.';
  }

  const tagRegex = /<\/?([A-Za-z_][\w:.-]*)(\s[^>]*)?\/?>/g;
  const stack: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(stripped)) !== null) {
    const full = match[0];
    const name = match[1];
    if (full.endsWith('/>')) {
      continue;
    }
    if (full.startsWith('</')) {
      const top = stack.pop();
      if (top !== name) {
        return `Tag de fechamento </${name}> divergente da tag aberta <${top ?? 'nenhuma'}>.`;
      }
    } else {
      stack.push(name);
    }
  }

  if (stack.length > 0) {
    return `Tags XML nao fechadas: ${stack.join(', ')}.`;
  }
  return null;
}

/**
 * Validador XSD estrutural e semantico para eventos eSocial S-1.2 e S-1.3
 */
export function validateEsocialXml(
  xml: string,
  eventType: EsocialOutboundEventType,
  layoutVersion: EsocialLayoutVersion = 'S-1.3'
): EsocialValidationResult {
  const errors: EsocialValidationError[] = [];
  const expectedNs = getEsocialNamespace(eventType, layoutVersion);
  const rootTag = getEsocialRootTag(eventType);

  if (!xml || xml.trim().length === 0) {
    return {
      valid: false,
      eventType,
      layoutVersion,
      eventId: null,
      errors: [{ code: 'XSD_EMPTY', field: 'xml', message: 'XML vazio.' }],
    };
  }

  const syntaxErr = checkWellFormedXml(xml);
  if (syntaxErr) {
    errors.push({ code: 'XSD_SYNTAX', field: 'xml', message: syntaxErr });
  }

  if (!xml.includes(`xmlns="${expectedNs}"`)) {
    errors.push({
      code: 'XSD_NAMESPACE',
      field: 'xmlns',
      message: `Namespace divergente do leiaute ${layoutVersion}. Esperado: ${expectedNs}`,
    });
  }

  const rootMatch = new RegExp(`<${rootTag}\\s+Id="([^"]+)"`).exec(xml);
  const eventId = rootMatch ? rootMatch[1] : null;
  if (!eventId) {
    errors.push({
      code: 'XSD_EVENT_ID_MISSING',
      field: `${rootTag}@Id`,
      message: `Elemento <${rootTag}> sem atributo obrigatorio Id.`,
    });
  } else if (!/^ID[12]\d{33}$/.test(eventId)) {
    errors.push({
      code: 'XSD_EVENT_ID_FORMAT',
      field: `${rootTag}@Id`,
      message: `Atributo Id="${eventId}" fora do padrao eSocial (36 caracteres: ID + tpInsc + 14 + 14 + 5).`,
    });
  }

  const tpAmb = extractTagValue(xml, 'tpAmb');
  if (tpAmb !== '1' && tpAmb !== '2') {
    errors.push({
      code: 'XSD_TP_AMB',
      field: 'tpAmb',
      message: 'tpAmb deve ser 1 (Producao) ou 2 (Producao Restrita).',
    });
  }

  const tpInsc = extractTagValue(xml, 'tpInsc');
  if (tpInsc !== '1' && tpInsc !== '2') {
    errors.push({
      code: 'XSD_TP_INSC',
      field: 'tpInsc',
      message: 'tpInsc do empregador deve ser 1 (CNPJ) ou 2 (CPF).',
    });
  }

  const spec = EVENT_SPECS[eventType];
  for (const tag of spec.requiredTags) {
    if (!hasTag(xml, tag)) {
      errors.push({
        code: 'XSD_REQUIRED_TAG',
        field: tag,
        message: `Tag obrigatoria <${tag}> ausente no evento ${eventType}.`,
      });
    }
  }

  if (spec.tagPatterns) {
    for (const rule of spec.tagPatterns) {
      const val = extractTagValue(xml, rule.tag);
      if (val !== null && !rule.regex.test(val)) {
        errors.push({
          code: 'XSD_PATTERN',
          field: rule.tag,
          message: `${rule.message} (valor encontrado: "${val}")`,
        });
      }
    }
  }

  return {
    valid: errors.length === 0,
    eventType,
    layoutVersion,
    eventId,
    errors,
  };
}
