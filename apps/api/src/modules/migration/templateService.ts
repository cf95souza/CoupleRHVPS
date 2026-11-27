import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export interface MigrationTemplateInfo {
  key: string;
  filename: string;
  title: string;
  description: string;
  required: boolean;
  order: number;
  format: 'CSV' | 'MARKDOWN';
  mimeType: string;
}

const TEMPLATES: Record<string, MigrationTemplateInfo> = {
  colaboradores_contratos: {
    key: 'colaboradores_contratos',
    filename: '01_colaboradores_contratos_dependentes.csv',
    title: '1. Colaboradores, Contratos e Dependentes',
    description: 'Cadastro dos trabalhadores ativos e desligados em 2026, vínculos empregatícios (CLT, Aprendiz, Estágio), dados bancários e dependentes de IRRF/Salário-Família.',
    required: true,
    order: 1,
    format: 'CSV',
    mimeType: 'text/csv; charset=utf-8',
  },
  historico_folha: {
    key: 'historico_folha',
    filename: '02_historico_folha_2026_ficha_financeira.csv',
    title: '2. Histórico de Folha 2026 (Ficha Financeira Mensal)',
    description: 'Demonstrativo mensal de todas as rubricas pagas e descontadas de Jan/2026 até a virada, preservando horas extras, adicional noturno, faltas injustificadas (801), INSS, IRRF e bases.',
    required: true,
    order: 2,
    format: 'CSV',
    mimeType: 'text/csv; charset=utf-8',
  },
  saldos_ferias: {
    key: 'saldos_ferias',
    filename: '03_saldos_ferias_periodos_aquisitivos.csv',
    title: '3. Saldos de Férias e Períodos Aquisitivos',
    description: 'Posição dos períodos aquisitivos em aberto e vencidos na data da virada, histórico de faltas acumuladas (Art. 130 CLT), dias gozados e limite concessivo.',
    required: false,
    order: 3,
    format: 'CSV',
    mimeType: 'text/csv; charset=utf-8',
  },
  afastamentos: {
    key: 'afastamentos',
    filename: '04_afastamentos_2026_e_em_curso.csv',
    title: '4. Afastamentos de 2026 e em Curso',
    description: 'Histórico de licenças médicas, auxílio-doença (15 dias pagos pela empresa + INSS), maternidade, acidentes de trabalho e estabilidades provisórias vigentes.',
    required: false,
    order: 4,
    format: 'CSV',
    mimeType: 'text/csv; charset=utf-8',
  },
  banco_horas: {
    key: 'banco_horas',
    filename: '05_saldo_inicial_banco_de_horas.csv',
    title: '5. Saldo Inicial de Banco de Horas',
    description: 'Saldo inicial em minutos e horas (positivo ou negativo) apurado até o último fechamento de ponto do sistema anterior para continuidade das apurações.',
    required: false,
    order: 5,
    format: 'CSV',
    mimeType: 'text/csv; charset=utf-8',
  },
  consignados_debitos: {
    key: 'consignados_debitos',
    filename: '06_emprestimos_consignados_e_debitos_anteriores.csv',
    title: '6. Empréstimos Consignados e Débitos Anteriores',
    description: 'Contratos de empréstimo consignado com parcelas restantes para desconto em folha e eventuais saldos devedores de insuficiência de saldo (rubrica 899).',
    required: false,
    order: 6,
    format: 'CSV',
    mimeType: 'text/csv; charset=utf-8',
  },
  guia_rh: {
    key: 'guia_rh',
    filename: 'README_GUIA_PREENCHIMENTO_RH.md',
    title: 'Guia Completo de Preenchimento para o RH',
    description: 'Manual passo a passo com orientações de preenchimento, tabela de-para de rubricas, regras da Súmula 347 TST para médias e checklist para validação sem erros.',
    required: false,
    order: 7,
    format: 'MARKDOWN',
    mimeType: 'text/markdown; charset=utf-8',
  },
};

export class MigrationTemplateService {
  private static findTemplatesDirectory(): string {
    const candidates = [
      path.resolve(process.cwd(), 'docs/modelos-importacao-rh'),
      path.resolve(process.cwd(), '../../docs/modelos-importacao-rh'),
      path.resolve(process.cwd(), '../docs/modelos-importacao-rh'),
    ];

    try {
      const currentDir = path.dirname(fileURLToPath(import.meta.url));
      candidates.push(
        path.resolve(currentDir, '../../../../docs/modelos-importacao-rh'),
        path.resolve(currentDir, '../../../../../docs/modelos-importacao-rh')
      );
    } catch {
      // Ignora se fileURLToPath falhar
    }

    for (const dir of candidates) {
      if (fs.existsSync(dir)) {
        return dir;
      }
    }

    throw new Error('Diretório de modelos de importação não encontrado (docs/modelos-importacao-rh).');
  }

  /**
   * Retorna a lista de modelos de importação disponíveis
   */
  public listTemplates(): MigrationTemplateInfo[] {
    return Object.values(TEMPLATES).sort((a, b) => a.order - b.order);
  }

  /**
   * Obtém os metadados de um modelo específico
   */
  public getTemplateInfo(key: string): MigrationTemplateInfo | null {
    return TEMPLATES[key] || null;
  }

  /**
   * Lê o arquivo de template e retorna seu conteúdo com UTF-8 BOM para compatibilidade com Excel PT-BR
   */
  public getTemplateContent(key: string): { content: Buffer; info: MigrationTemplateInfo } {
    const info = this.getTemplateInfo(key);
    if (!info) {
      throw new Error(`Modelo de importação não encontrado para a chave: "${key}".`);
    }

    const dir = MigrationTemplateService.findTemplatesDirectory();
    const filePath = path.join(dir, info.filename);

    if (!fs.existsSync(filePath)) {
      throw new Error(`Arquivo do modelo "${info.filename}" não encontrado no diretório de modelos.`);
    }

    const rawContent = fs.readFileSync(filePath, 'utf8');

    // Para arquivos CSV, inclui o Byte Order Mark (BOM: \uFEFF) para que o Excel
    // no Windows abra os acentos em português (ç, ã, é, etc.) perfeitamente sem corromper.
    let fileBuffer: Buffer;
    if (info.format === 'CSV') {
      const contentWithBom = rawContent.startsWith('\uFEFF') ? rawContent : `\uFEFF${rawContent}`;
      fileBuffer = Buffer.from(contentWithBom, 'utf8');
    } else {
      fileBuffer = Buffer.from(rawContent, 'utf8');
    }

    return { content: fileBuffer, info };
  }
}
