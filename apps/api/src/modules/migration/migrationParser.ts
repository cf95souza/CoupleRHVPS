/**
 * Parsers para Carga de Dados Históricos e Implantação de Folha
 * Suporte a CSV estruturado (delimitador ';') e XMLs do eSocial (S-2200, S-1200, S-1210, S-2230)
 */

export interface ParsedWorkerRow {
  cnpjEmpresa: string;
  cnpjFilial: string;
  cpf: string;
  pisPasep?: string;
  matricula: string;
  nomeCompleto: string;
  dataNascimento: string;
  dataAdmissao: string;
  departamento: string;
  centroCusto: string;
  cargo: string;
  cbo: string;
  regimeCalculo: string; // CLT, APPRENTICE, INTERMITTENT, etc.
  categoriaEsocial: string; // 101, 103, 111, etc.
  tipoSalario: string; // MONTHLY, HOURLY
  salarioBase: number;
  horasMensaisDivisor: number;
  horasSemanais: number;
  recebeAdiantamento: boolean;
  percentualAdiantamento: number;
  bancoCodigo?: string;
  agencia?: string;
  conta?: string;
  tipoConta?: string;
  chavePix?: string;
  qtdDependentesIrrf: number;
  qtdDependentesSalFamilia: number;
  email?: string;
  telefone?: string;
  observacao?: string;
}

export interface ParsedPayrollHistoryRow {
  cpf: string;
  matricula: string;
  nome: string;
  ano: number;
  mes: number;
  tipoFolha: string; // MONTHLY, VACATION, THIRTEENTH_1, THIRTEENTH_2, etc.
  dataPagamento: string; // YYYY-MM-DD
  codigoRubricaLegado: string;
  codigoRubricaCouplerh: string;
  descricaoRubrica: string;
  tipoEvento: 'EARNING' | 'DEDUCTION' | 'NEUTRAL';
  unidadeReferencia: 'HORAS' | 'DIAS' | 'AVOS' | 'VALOR' | 'PERCENTUAL';
  quantidadeReferencia: number;
  valorReais: number;
  baseInssHolerite: number;
  baseIrrfHolerite: number;
  baseFgtsHolerite: number;
  observacao?: string;
}

export interface ParsedEsocialEvent {
  eventType: 'S-2200' | 'S-1200' | 'S-1210' | 'S-2230' | 'UNKNOWN';
  rawXml: string;
  workerCpf: string;
  matricula?: string;
  data: any;
}

export interface ParsedVacationBalanceRow {
  cpf: string;
  matricula: string;
  nome: string;
  inicioAquisitivo: string; // YYYY-MM-DD
  fimAquisitivo: string;    // YYYY-MM-DD
  limiteConcessivo: string; // YYYY-MM-DD
  diasDireito: number;
  diasGozados: number;
  diasVendidosAbono: number;
  diasSaldoRestante: number;
  faltasInjustificadas: number;
  status: 'DRAFT' | 'OPEN' | 'IN_PROGRESS' | 'CLOSED' | 'EXPIRED' | 'FORFEITED';
  observacao?: string;
}

export interface ParsedLeaveRow {
  cpf: string;
  matricula: string;
  nome: string;
  tipoAfastamento: string;
  codigoMotivoEsocial: string;
  dataInicio: string; // YYYY-MM-DD
  dataFimPrevista?: string;
  dataRetornoEfetivo?: string;
  diasPagosEmpresa: number;
  cid10Sigiloso?: string;
  mesmaCid60Dias: boolean;
  maternidadeEstendida180d: boolean;
  estabilidadeAte?: string;
  observacao?: string;
}

export interface ParsedTimeBankRow {
  cpf: string;
  matricula: string;
  nome: string;
  dataCorteSaldo: string; // YYYY-MM-DD
  saldoHorasHhmm: string; // "+14:30", "-04:15"
  saldoMinutosLiquido: number; // +870, -255
  regimeHorasExtras: string;
  observacao?: string;
}

export interface ParsedLoanAndDebtRow {
  cpf: string;
  matricula: string;
  nome: string;
  tipoRegistro: 'CONSIGNADO' | 'DEBITO_INSUFICIENCIA_899';
  instituicaoFinanceira?: string;
  numeroContrato?: string;
  valorTotal?: number;
  valorParcela?: number;
  totalParcelas?: number;
  parcelasJaPagas?: number;
  dataInicio?: string;
  competenciaOrigemDebito?: string;
  saldoRestanteDebito?: number;
  observacao?: string;
}

export class MigrationParser {
  /**
   * Divide linhas de texto suportando LF e CRLF
   */
  public static splitLines(content: string): string[] {
    // Remove BOM se presente
    const cleanContent = content.replace(/^\uFEFF/, '');
    return cleanContent
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  }

  /**
   * Converte linha CSV com separador ';' ou ',' em array de strings limpas
   */
  public static parseCsvLine(line: string, delimiter = ';'): string[] {
    const parts: string[] = [];
    let cur = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === delimiter && !inQuotes) {
        parts.push(cur.trim().replace(/^"|"$/g, ''));
        cur = '';
      } else {
        cur += char;
      }
    }
    parts.push(cur.trim().replace(/^"|"$/g, ''));
    return parts;
  }

  /**
   * Converte valor monetário em string ("1.234,56" ou "1234.56") para número
   */
  public static parseNumber(value: string | undefined | null): number {
    if (!value) return 0;
    const clean = String(value).trim();
    if (!clean) return 0;

    // Se possui vírgula como separador decimal
    if (clean.includes(',')) {
      const sanitized = clean.replace(/\./g, '').replace(',', '.');
      const num = Number(sanitized);
      return isNaN(num) ? 0 : Math.round(num * 100) / 100;
    }

    const num = Number(clean);
    return isNaN(num) ? 0 : Math.round(num * 100) / 100;
  }

  /**
   * Limpa CPF mantendo apenas 11 dígitos numéricos
   */
  public static cleanCpf(cpf: string | undefined | null): string {
    if (!cpf) return '';
    const digits = String(cpf).replace(/\D/g, '');
    return digits.padStart(11, '0').slice(-11);
  }

  /**
   * Limpa CNPJ mantendo apenas 14 dígitos numéricos
   */
  public static cleanCnpj(cnpj: string | undefined | null): string {
    if (!cnpj) return '';
    const digits = String(cnpj).replace(/\D/g, '');
    return digits.padStart(14, '0').slice(-14);
  }

  /**
   * Faz o parser do CSV de colaboradores, contratos e dependentes
   */
  public static parseWorkersAndContractsCsv(content: string): ParsedWorkerRow[] {
    const lines = this.splitLines(content);
    if (lines.length <= 1) return [];

    const headers = this.parseCsvLine(lines[0].toLowerCase());
    const rows: ParsedWorkerRow[] = [];

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      const cols = this.parseCsvLine(line);
      if (cols.length < 5) continue;

      const obs = cols[29] || '';
      // Pula linha de exemplo
      if (obs.toUpperCase().includes('EXEMPLO') || cols[0].toUpperCase().includes('EXEMPLO')) {
        continue;
      }

      const cpf = this.cleanCpf(cols[2]);
      if (!cpf || cpf.length !== 11) continue;

      const row: ParsedWorkerRow = {
        cnpjEmpresa: this.cleanCnpj(cols[0]),
        cnpjFilial: this.cleanCnpj(cols[1]),
        cpf,
        pisPasep: cols[3]?.replace(/\D/g, '') || undefined,
        matricula: cols[4] || `MAT-${cpf.slice(-4)}`,
        nomeCompleto: cols[5] || 'Colaborador sem Nome',
        dataNascimento: cols[6] || '1990-01-01',
        dataAdmissao: cols[7] || '2026-01-01',
        departamento: cols[8] || 'Geral',
        centroCusto: cols[9] || 'CC-PADRAO',
        cargo: cols[10] || 'Operador',
        cbo: cols[11]?.replace(/\D/g, '') || '411005',
        regimeCalculo: (cols[12] || 'CLT').toUpperCase(),
        categoriaEsocial: cols[13] || '101',
        tipoSalario: (cols[14] || 'MONTHLY').toUpperCase(),
        salarioBase: this.parseNumber(cols[15]),
        horasMensaisDivisor: this.parseNumber(cols[16]) || 220,
        horasSemanais: this.parseNumber(cols[17]) || 44,
        recebeAdiantamento: cols[18]?.toUpperCase() === 'SIM',
        percentualAdiantamento: this.parseNumber(cols[19]) || 40,
        bancoCodigo: cols[20] || undefined,
        agencia: cols[21] || undefined,
        conta: cols[22] || undefined,
        tipoConta: cols[23] || 'CHECKING',
        chavePix: cols[24] || undefined,
        qtdDependentesIrrf: Math.max(0, parseInt(cols[25] || '0', 10) || 0),
        qtdDependentesSalFamilia: Math.max(0, parseInt(cols[26] || '0', 10) || 0),
        email: cols[27] || undefined,
        telefone: cols[28] || undefined,
        observacao: obs || undefined,
      };

      rows.push(row);
    }

    return rows;
  }

  /**
   * Faz o parser do CSV de Histórico de Folha 2026 (Ficha Financeira Mensal)
   */
  public static parsePayrollHistoryCsv(content: string): ParsedPayrollHistoryRow[] {
    const lines = this.splitLines(content);
    if (lines.length <= 1) return [];

    const rows: ParsedPayrollHistoryRow[] = [];

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      const cols = this.parseCsvLine(line);
      if (cols.length < 10) continue;

      const obs = cols[17] || '';
      if (obs.toUpperCase().includes('EXEMPLO') || cols[0].toUpperCase().includes('EXEMPLO')) {
        continue;
      }

      const cpf = this.cleanCpf(cols[0]);
      if (!cpf || cpf.length !== 11) continue;

      const ano = parseInt(cols[3] || '2026', 10) || 2026;
      const mes = parseInt(cols[4] || '1', 10) || 1;
      let tipoFolha = (cols[5] || 'MONTHLY').toUpperCase();
      if (tipoFolha === '13TH_1' || tipoFolha === '13_1') tipoFolha = 'THIRTEENTH_1';
      if (tipoFolha === '13TH_2' || tipoFolha === '13_2') tipoFolha = 'THIRTEENTH_2';

      let tipoEvento = (cols[10] || 'EARNING').toUpperCase() as 'EARNING' | 'DEDUCTION' | 'NEUTRAL';
      if (!['EARNING', 'DEDUCTION', 'NEUTRAL'].includes(tipoEvento)) {
        tipoEvento = 'EARNING';
      }

      let unidadeRef = (cols[11] || 'VALOR').toUpperCase() as 'HORAS' | 'DIAS' | 'AVOS' | 'VALOR' | 'PERCENTUAL';
      if (!['HORAS', 'DIAS', 'AVOS', 'VALOR', 'PERCENTUAL'].includes(unidadeRef)) {
        unidadeRef = 'VALOR';
      }

      const row: ParsedPayrollHistoryRow = {
        cpf,
        matricula: cols[1] || `MAT-${cpf.slice(-4)}`,
        nome: cols[2] || 'Colaborador',
        ano,
        mes,
        tipoFolha,
        dataPagamento: cols[6] || `${ano}-${String(mes).padStart(2, '0')}-05`,
        codigoRubricaLegado: cols[7] || '',
        codigoRubricaCouplerh: cols[8] || cols[7] || '101',
        descricaoRubrica: cols[9] || 'Evento de Folha',
        tipoEvento,
        unidadeReferencia: unidadeRef,
        quantidadeReferencia: this.parseNumber(cols[12]),
        valorReais: this.parseNumber(cols[13]),
        baseInssHolerite: this.parseNumber(cols[14]),
        baseIrrfHolerite: this.parseNumber(cols[15]),
        baseFgtsHolerite: this.parseNumber(cols[16]),
        observacao: obs || undefined,
      };

      rows.push(row);
    }

    return rows;
  }

  /**
   * Parser básico de XML do eSocial extraindo dados de S-2200, S-1200, S-1210 e S-2230
   */
  public static parseEsocialXml(xmlString: string): ParsedEsocialEvent {
    let eventType: ParsedEsocialEvent['eventType'] = 'UNKNOWN';
    if (xmlString.includes('<evtAdmissao') || xmlString.includes('S-2200')) {
      eventType = 'S-2200';
    } else if (xmlString.includes('<evtRemun') || xmlString.includes('S-1200')) {
      eventType = 'S-1200';
    } else if (xmlString.includes('<evtPgtos') || xmlString.includes('S-1210')) {
      eventType = 'S-1210';
    } else if (xmlString.includes('<evtAfastTemp') || xmlString.includes('S-2230')) {
      eventType = 'S-2230';
    }

    // Extrai CPF do trabalhador via regex
    const cpfMatch = xmlString.match(/<cpfTrab>(\d{11})<\/cpfTrab>/i);
    const workerCpf = cpfMatch ? cpfMatch[1] : '';

    // Extrai matrícula se houver
    const matMatch = xmlString.match(/<matricula>([^<]+)<\/matricula>/i);
    const matricula = matMatch ? matMatch[1].trim() : undefined;

    const data: any = {};

    if (eventType === 'S-2200') {
      const nmMatch = xmlString.match(/<nmTrab>([^<]+)<\/nmTrab>/i);
      const dtNascto = xmlString.match(/<dtNascto>([^<]+)<\/dtNascto>/i);
      const dtAdm = xmlString.match(/<dtAdm>([^<]+)<\/dtAdm>/i);
      const vrSalFx = xmlString.match(/<vrSalFx>([^<]+)<\/vrSalFx>/i);
      const cbo = xmlString.match(/<cbos>([^<]+)<\/cbos>/i);
      const codCateg = xmlString.match(/<codCateg>([^<]+)<\/codCateg>/i);

      data.nome = nmMatch ? nmMatch[1].trim() : '';
      data.dataNascimento = dtNascto ? dtNascto[1].trim() : '';
      data.dataAdmissao = dtAdm ? dtAdm[1].trim() : '';
      data.salarioBase = this.parseNumber(vrSalFx ? vrSalFx[1] : '0');
      data.cbo = cbo ? cbo[1].trim() : '';
      data.categoria = codCateg ? codCateg[1].trim() : '101';
    } else if (eventType === 'S-1200') {
      const perApurMatch = xmlString.match(/<perApur>([^<]+)<\/perApur>/i);
      data.perApur = perApurMatch ? perApurMatch[1].trim() : ''; // YYYY-MM

      // Extrai itens de remuneração
      const rubricas: any[] = [];
      const itemRegex = /<itensRemun>([\s\S]*?)<\/itensRemun>/gi;
      let itemMatch;
      while ((itemMatch = itemRegex.exec(xmlString)) !== null) {
        const itemBlock = itemMatch[1];
        const codRubr = itemBlock.match(/<codRubr>([^<]+)<\/codRubr>/i)?.[1]?.trim() || '';
        const qtdRubr = itemBlock.match(/<qtdRubr>([^<]+)<\/qtdRubr>/i)?.[1]?.trim();
        const vrRubr = itemBlock.match(/<vrRubr>([^<]+)<\/vrRubr>/i)?.[1]?.trim();
        rubricas.push({
          codRubr,
          quantidade: this.parseNumber(qtdRubr),
          valor: this.parseNumber(vrRubr),
        });
      }
      data.rubricas = rubricas;
    } else if (eventType === 'S-1210') {
      const perApurMatch = xmlString.match(/<perApur>([^<]+)<\/perApur>/i);
      const dtPgtoMatch = xmlString.match(/<dtPgto>([^<]+)<\/dtPgto>/i);
      const vrLiqMatch = xmlString.match(/<vrLiq>([^<]+)<\/vrLiq>/i);

      data.perApur = perApurMatch ? perApurMatch[1].trim() : '';
      data.dataPagamento = dtPgtoMatch ? dtPgtoMatch[1].trim() : '';
      data.valorLiquido = this.parseNumber(vrLiqMatch ? vrLiqMatch[1] : '0');
    } else if (eventType === 'S-2230') {
      const dtIniAfast = xmlString.match(/<dtIniAfast>([^<]+)<\/dtIniAfast>/i)?.[1]?.trim();
      const codMotAfast = xmlString.match(/<codMotAfast>([^<]+)<\/codMotAfast>/i)?.[1]?.trim();
      const dtTermAfast = xmlString.match(/<dtTermAfast>([^<]+)<\/dtTermAfast>/i)?.[1]?.trim();

      data.dataInicio = dtIniAfast || '';
      data.motivoEsocial = codMotAfast || '';
      data.dataFim = dtTermAfast || null;
    }

    return {
      eventType,
      rawXml: xmlString,
      workerCpf,
      matricula,
      data,
    };
  }

  /**
   * Parser do modelo 03: Saldos de Férias e Períodos Aquisitivos (CLT Art. 130 / 134 / 137)
   */
  public static parseVacationBalancesCsv(content: string): ParsedVacationBalanceRow[] {
    const lines = this.splitLines(content);
    if (lines.length <= 1) return [];

    const rows: ParsedVacationBalanceRow[] = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = this.parseCsvLine(lines[i]);
      if (cols.length < 7) continue;

      const obs = cols[12] || '';
      if (obs.toUpperCase().includes('EXEMPLO') || cols[0].toUpperCase().includes('EXEMPLO')) {
        continue;
      }

      const cpf = this.cleanCpf(cols[0]);
      if (!cpf || cpf.length !== 11) continue;

      let rawStatus = (cols[11] || 'OPEN').toUpperCase();
      let status: ParsedVacationBalanceRow['status'] = 'OPEN';
      if (['DRAFT', 'OPEN', 'IN_PROGRESS', 'CLOSED', 'EXPIRED', 'FORFEITED'].includes(rawStatus)) {
        status = rawStatus as any;
      }

      const diasDireito = this.parseNumber(cols[6]) || 30;
      const diasGozados = this.parseNumber(cols[7]) || 0;
      const diasVendidos = this.parseNumber(cols[8]) || 0;
      const diasSaldo = cols[9] !== undefined && cols[9] !== '' 
        ? this.parseNumber(cols[9]) 
        : Math.max(0, diasDireito - diasGozados - diasVendidos);
      const faltas = parseInt(cols[10] || '0', 10) || 0;

      rows.push({
        cpf,
        matricula: cols[1] || `MAT-${cpf.slice(-4)}`,
        nome: cols[2] || 'Colaborador',
        inicioAquisitivo: cols[3] || '2025-01-01',
        fimAquisitivo: cols[4] || '2025-12-31',
        limiteConcessivo: cols[5] || '2026-12-31',
        diasDireito,
        diasGozados,
        diasVendidosAbono: diasVendidos,
        diasSaldoRestante: diasSaldo,
        faltasInjustificadas: faltas,
        status,
        observacao: obs || undefined,
      });
    }

    return rows;
  }

  /**
   * Parser do modelo 04: Afastamentos 2026 e em Curso (eSocial S-2230, CID-10, Estabilidade, DCTFWeb)
   */
  public static parseLeavesCsv(content: string): ParsedLeaveRow[] {
    const lines = this.splitLines(content);
    if (lines.length <= 1) return [];

    const rows: ParsedLeaveRow[] = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = this.parseCsvLine(lines[i]);
      if (cols.length < 6) continue;

      const obs = cols[13] || '';
      if (obs.toUpperCase().includes('EXEMPLO') || cols[0].toUpperCase().includes('EXEMPLO')) {
        continue;
      }

      const cpf = this.cleanCpf(cols[0]);
      if (!cpf || cpf.length !== 11) continue;

      rows.push({
        cpf,
        matricula: cols[1] || `MAT-${cpf.slice(-4)}`,
        nome: cols[2] || 'Colaborador',
        tipoAfastamento: (cols[3] || 'OUTROS').toUpperCase(),
        codigoMotivoEsocial: cols[4] || '01',
        dataInicio: cols[5],
        dataFimPrevista: cols[6] || undefined,
        dataRetornoEfetivo: cols[7] || undefined,
        diasPagosEmpresa: this.parseNumber(cols[8]) || 0,
        cid10Sigiloso: cols[9] || undefined,
        mesmaCid60Dias: cols[10]?.toUpperCase() === 'SIM',
        maternidadeEstendida180d: cols[11]?.toUpperCase() === 'SIM',
        estabilidadeAte: cols[12] || undefined,
        observacao: obs || undefined,
      });
    }

    return rows;
  }

  /**
   * Parser do modelo 05: Saldo Inicial de Banco de Horas na Virada
   */
  public static parseTimeBankCsv(content: string): ParsedTimeBankRow[] {
    const lines = this.splitLines(content);
    if (lines.length <= 1) return [];

    const rows: ParsedTimeBankRow[] = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = this.parseCsvLine(lines[i]);
      if (cols.length < 5) continue;

      const obs = cols[7] || '';
      if (obs.toUpperCase().includes('EXEMPLO') || cols[0].toUpperCase().includes('EXEMPLO')) {
        continue;
      }

      const cpf = this.cleanCpf(cols[0]);
      if (!cpf || cpf.length !== 11) continue;

      let minutos = parseInt(cols[5] || '0', 10);
      const horasHhmm = cols[4] || '00:00';
      if (isNaN(minutos) && horasHhmm) {
        // Converte HH:MM para minutos
        const sign = horasHhmm.startsWith('-') ? -1 : 1;
        const cleanHh = horasHhmm.replace(/^[+-]/, '');
        const [hh, mm] = cleanHh.split(':').map((v) => parseInt(v, 10) || 0);
        minutos = sign * (hh * 60 + mm);
      }

      rows.push({
        cpf,
        matricula: cols[1] || `MAT-${cpf.slice(-4)}`,
        nome: cols[2] || 'Colaborador',
        dataCorteSaldo: cols[3] || '2026-10-31',
        saldoHorasHhmm: horasHhmm,
        saldoMinutosLiquido: minutos,
        regimeHorasExtras: cols[6] || 'BANCO_HORAS',
        observacao: obs || undefined,
      });
    }

    return rows;
  }

  /**
   * Parser do modelo 06: Empréstimos Consignados e Débitos Anteriores (Insuficiência 899)
   */
  public static parseLoansAndDebtsCsv(content: string): ParsedLoanAndDebtRow[] {
    const lines = this.splitLines(content);
    if (lines.length <= 1) return [];

    const rows: ParsedLoanAndDebtRow[] = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = this.parseCsvLine(lines[i]);
      if (cols.length < 4) continue;

      const obs = cols[13] || '';
      if (obs.toUpperCase().includes('EXEMPLO') || cols[0].toUpperCase().includes('EXEMPLO')) {
        continue;
      }

      const cpf = this.cleanCpf(cols[0]);
      if (!cpf || cpf.length !== 11) continue;

      let tipoRegRaw = (cols[3] || '').toUpperCase();
      let tipoRegistro: ParsedLoanAndDebtRow['tipoRegistro'] = 'CONSIGNADO';
      if (tipoRegRaw.includes('DEBITO') || tipoRegRaw.includes('899') || tipoRegRaw.includes('INSUFICIENCIA')) {
        tipoRegistro = 'DEBITO_INSUFICIENCIA_899';
      }

      rows.push({
        cpf,
        matricula: cols[1] || `MAT-${cpf.slice(-4)}`,
        nome: cols[2] || 'Colaborador',
        tipoRegistro,
        instituicaoFinanceira: cols[4] || undefined,
        numeroContrato: cols[5] || undefined,
        valorTotal: cols[6] ? this.parseNumber(cols[6]) : undefined,
        valorParcela: cols[7] ? this.parseNumber(cols[7]) : undefined,
        totalParcelas: cols[8] ? parseInt(cols[8], 10) : undefined,
        parcelasJaPagas: cols[9] ? parseInt(cols[9], 10) : undefined,
        dataInicio: cols[10] || undefined,
        competenciaOrigemDebito: cols[11] || undefined,
        saldoRestanteDebito: cols[12] ? this.parseNumber(cols[12]) : undefined,
        observacao: obs || undefined,
      });
    }

    return rows;
  }
}
