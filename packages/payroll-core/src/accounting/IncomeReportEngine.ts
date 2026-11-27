/**
 * IncomeReportEngine.ts
 * FASE V7 — CONT-05: Comprovante de Rendimentos Pagos e de Imposto sobre a Renda Retido na Fonte
 * Padrão Oficial RFB (Quadros 1 a 7):
 * - Quadro 1: Fonte Pagadora
 * - Quadro 2: Pessoa Física Beneficiária
 * - Quadro 3: Rendimentos Tributáveis, Deduções e IRRF
 * - Quadro 4: Rendimentos Isentos e Não Tributáveis
 * - Quadro 5: Rendimentos Sujeitos à Tributação Exclusiva (13º Salário e PLR)
 * - Quadro 6: Rendimentos Recebidos Acumuladamente (RRA - Art. 12-A)
 * - Quadro 7: Informações Complementares (Pensão por Beneficiário/CPF e Planos de Saúde ANS Titular/Dependentes)
 */

import { round2, sumMoney } from '../utils/money.js';

export interface IncomeAlimonyComplementItem {
  beneficiaryName: string;
  beneficiaryCpf?: string | null;
  beneficiaryBirthDate?: string | null;
  relationship?: string | null;
  totalAmount: number;
}

export interface IncomeHealthPlanComplementItem {
  operatorName: string;
  operatorCnpj?: string | null;
  ansCode?: string | null;
  beneficiaryType: 'HOLDER' | 'DEPENDENT';
  beneficiaryName: string;
  beneficiaryCpf?: string | null;
  totalAmount: number;
}

export interface AnnualIncomeReportFullInput {
  calendarYear: number;
  company: {
    cnpj: string;
    corporateName: string;
  };
  worker: {
    cpf: string;
    fullName: string;
  };
  monthlyTaxableEarnings: number;
  officialSocialSecurityInss: number;
  privatePension: number;
  alimonyTotal: number;
  irrfMonthlyWithheld: number;
  exemptVacationAbono?: number;
  exemptDoubleVacation?: number;
  exemptTerminationIndemnity?: number;
  exemptFamilySalary?: number;
  exemptOther?: number;
  thirteenthGrossTaxable: number;
  thirteenthInss: number;
  thirteenthAlimony?: number;
  thirteenthIrrf: number;
  plrTotal?: number;
  plrIrrf?: number;
  rraProcessNumber?: string | null;
  rraMonthsCount?: number;
  rraTaxableAmount?: number;
  rraInssDeduction?: number;
  rraAlimonyDeduction?: number;
  rraIrrfWithheld?: number;
  alimonyDetails: IncomeAlimonyComplementItem[];
  healthPlanDetails: IncomeHealthPlanComplementItem[];
}

export interface AnnualIncomeReportFull {
  calendarYear: number;
  quadro1FontePagadora: {
    cnpj: string;
    nomeEmpresarial: string;
  };
  quadro2Beneficiario: {
    cpf: string;
    nomeCompleto: string;
    naturezaRendimento: string;
  };
  quadro3Tributaveis: {
    totalRendimentos: number;
    contribuicaoPrevidenciariaOficial: number;
    previdenciaComplementar: number;
    pensaoAlimenticia: number;
    impostoRetidoFonte: number;
  };
  quadro4Isentos: {
    abonoPecuniarioFerias: number;
    feriasEmDobroArt137: number;
    indenizacaoRescisaoFgtsAviso: number;
    salarioFamilia: number;
    outrosIsentos: number;
    totalIsentos: number;
  };
  quadro5Exclusiva: {
    decimoTerceiroLiquidoQuadro: number;
    decimoTerceiroBruto: number;
    irrfSobreDecimoTerceiro: number;
    plrBruto: number;
    irrfSobrePlr: number;
    outrosExclusiva: number;
  };
  quadro6Rra: {
    numeroProcessoOuAcordo: string;
    quantidadeMeses: number;
    rendimentosTributaveis: number;
    exclusaoPrevidenciaOficial: number;
    exclusaoPensaoAlimenticia: number;
    impostoRetidoFonte: number;
  };
  quadro7Complementares: {
    pensaoAlimenticiaBeneficiarios: IncomeAlimonyComplementItem[];
    planosSaude: IncomeHealthPlanComplementItem[];
    textoComplementar: string[];
  };
}

function formatMoneyBrStr(v: number): string {
  return round2(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export class IncomeReportEngine {
  /**
   * Constrói o Informe de Rendimentos completo padrão RFB (Quadros 1 a 7).
   */
  public static buildAnnualIncomeReport(input: AnnualIncomeReportFullInput): AnnualIncomeReportFull {
    const abono = round2(input.exemptVacationAbono || 0);
    const dobra = round2(input.exemptDoubleVacation || 0);
    const indTerm = round2(input.exemptTerminationIndemnity || 0);
    const salFam = round2(input.exemptFamilySalary || 0);
    const outrosIsentos = round2(input.exemptOther || 0);
    const totalIsentos = sumMoney([abono, dobra, indTerm, salFam, outrosIsentos]);

    // Regra RFB Quadro 5 linha 01: 13º Salário líquido das deduções de INSS, pensão e IRRF sobre o 13º
    const d13Bruto = round2(input.thirteenthGrossTaxable);
    const d13Inss = round2(input.thirteenthInss);
    const d13Pensao = round2(input.thirteenthAlimony || 0);
    const d13Irrf = round2(input.thirteenthIrrf);
    const d13LiquidoQuadro = Math.max(0, round2(d13Bruto - d13Inss - d13Pensao - d13Irrf));

    const plrBruto = round2(input.plrTotal || 0);
    const plrIrrf = round2(input.plrIrrf || 0);

    const textoComplementar: string[] = [];
    for (const p of input.alimonyDetails) {
      if (p.totalAmount <= 0) continue;
      textoComplementar.push(
        `Pensão Alimentícia Judicial - Beneficiário: ${p.beneficiaryName}${p.beneficiaryCpf ? ` (CPF: ${p.beneficiaryCpf})` : ''}${p.beneficiaryBirthDate ? ` | Nasc.: ${p.beneficiaryBirthDate}` : ''} | Valor pago no ano: R$ ${formatMoneyBrStr(p.totalAmount)}.`
      );
    }
    for (const hp of input.healthPlanDetails) {
      if (hp.totalAmount <= 0) continue;
      const roleLabel = hp.beneficiaryType === 'HOLDER' ? 'Titular' : 'Dependente';
      textoComplementar.push(
        `Plano de Saúde/Odonto - Operadora: ${hp.operatorName}${hp.operatorCnpj ? ` (CNPJ: ${hp.operatorCnpj})` : ''}${hp.ansCode ? ` [ANS ${hp.ansCode}]` : ''} | ${roleLabel}: ${hp.beneficiaryName}${hp.beneficiaryCpf ? ` (CPF: ${hp.beneficiaryCpf})` : ''} | Participação anual: R$ ${formatMoneyBrStr(hp.totalAmount)}.`
      );
    }

    return {
      calendarYear: input.calendarYear,
      quadro1FontePagadora: {
        cnpj: input.company.cnpj,
        nomeEmpresarial: input.company.corporateName,
      },
      quadro2Beneficiario: {
        cpf: input.worker.cpf,
        nomeCompleto: input.worker.fullName,
        naturezaRendimento: 'Rendimentos do trabalho assalariado',
      },
      quadro3Tributaveis: {
        totalRendimentos: round2(input.monthlyTaxableEarnings),
        contribuicaoPrevidenciariaOficial: round2(input.officialSocialSecurityInss),
        previdenciaComplementar: round2(input.privatePension),
        pensaoAlimenticia: round2(input.alimonyTotal),
        impostoRetidoFonte: round2(input.irrfMonthlyWithheld),
      },
      quadro4Isentos: {
        abonoPecuniarioFerias: abono,
        feriasEmDobroArt137: dobra,
        indenizacaoRescisaoFgtsAviso: indTerm,
        salarioFamilia: salFam,
        outrosIsentos,
        totalIsentos,
      },
      quadro5Exclusiva: {
        decimoTerceiroLiquidoQuadro: d13LiquidoQuadro,
        decimoTerceiroBruto: d13Bruto,
        irrfSobreDecimoTerceiro: d13Irrf,
        plrBruto,
        irrfSobrePlr: plrIrrf,
        outrosExclusiva: Math.max(0, round2(plrBruto - plrIrrf)),
      },
      quadro6Rra: {
        numeroProcessoOuAcordo: input.rraProcessNumber || '',
        quantidadeMeses: Number(input.rraMonthsCount || 0),
        rendimentosTributaveis: round2(input.rraTaxableAmount || 0),
        exclusaoPrevidenciaOficial: round2(input.rraInssDeduction || 0),
        exclusaoPensaoAlimenticia: round2(input.rraAlimonyDeduction || 0),
        impostoRetidoFonte: round2(input.rraIrrfWithheld || 0),
      },
      quadro7Complementares: {
        pensaoAlimenticiaBeneficiarios: input.alimonyDetails,
        planosSaude: input.healthPlanDetails,
        textoComplementar,
      },
    };
  }

  /**
   * Renderiza HTML oficial imprimível (pronto para impressão em PDF via navegador) dos Quadros 1 a 7 RFB.
   */
  public static renderIncomeReportHtml(report: AnnualIncomeReportFull): string {
    const q3 = report.quadro3Tributaveis;
    const q4 = report.quadro4Isentos;
    const q5 = report.quadro5Exclusiva;
    const q6 = report.quadro6Rra;
    const compLines = report.quadro7Complementares.textoComplementar
      .map((line) => `<p style="margin:4px 0;">• ${line}</p>`)
      .join('') || '<p>Sem informações complementares no exercício.</p>';

    return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Informe de Rendimentos ${report.calendarYear} - ${report.quadro2Beneficiario.nomeCompleto}</title></head><body style="font-family:Arial,sans-serif;font-size:12px;color:#0f172a;padding:24px;">
<h2 style="margin-bottom:4px;">COMPROVANTE DE RENDIMENTOS PAGOS E DE IRRF — ANO-CALENDÁRIO ${report.calendarYear}</h2>
<p style="margin-top:0;color:#475569;">Documento emitido em conformidade com a Instrução Normativa RFB (Quadros 1 a 7)</p>
<table border="1" cellpadding="6" cellspacing="0" width="100%" style="border-collapse:collapse;margin-bottom:12px;">
<tr><th colspan="2" align="left" style="background:#f1f5f9;">1. FONTE PAGADORA</th></tr>
<tr><td><strong>CNPJ:</strong> ${report.quadro1FontePagadora.cnpj}</td><td><strong>Nome Empresarial:</strong> ${report.quadro1FontePagadora.nomeEmpresarial}</td></tr>
<tr><th colspan="2" align="left" style="background:#f1f5f9;">2. PESSOA FÍSICA BENEFICIÁRIA</th></tr>
<tr><td><strong>CPF:</strong> ${report.quadro2Beneficiario.cpf}</td><td><strong>Nome Completo:</strong> ${report.quadro2Beneficiario.nomeCompleto}</td></tr>
</table>
<table border="1" cellpadding="6" cellspacing="0" width="100%" style="border-collapse:collapse;margin-bottom:12px;">
<tr><th colspan="2" align="left" style="background:#f1f5f9;">3. RENDIMENTOS TRIBUTÁVEIS, DEDUÇÕES E IMPOSTO RETIDO NA FONTE</th></tr>
<tr><td>01. Total dos rendimentos (inclusive férias)</td><td align="right">R$ ${formatMoneyBrStr(q3.totalRendimentos)}</td></tr>
<tr><td>02. Contribuição previdenciária oficial</td><td align="right">R$ ${formatMoneyBrStr(q3.contribuicaoPrevidenciariaOficial)}</td></tr>
<tr><td>03. Contribuição a entidades de previdência complementar</td><td align="right">R$ ${formatMoneyBrStr(q3.previdenciaComplementar)}</td></tr>
<tr><td>04. Pensão alimentícia</td><td align="right">R$ ${formatMoneyBrStr(q3.pensaoAlimenticia)}</td></tr>
<tr><td>05. Imposto sobre a renda retido na fonte (IRRF)</td><td align="right">R$ ${formatMoneyBrStr(q3.impostoRetidoFonte)}</td></tr>
</table>
<table border="1" cellpadding="6" cellspacing="0" width="100%" style="border-collapse:collapse;margin-bottom:12px;">
<tr><th colspan="2" align="left" style="background:#f1f5f9;">4. RENDIMENTOS ISENTOS E NÃO TRIBUTÁVEIS</th></tr>
<tr><td>01. Abono pecuniário de férias / Férias em dobro Art. 137</td><td align="right">R$ ${formatMoneyBrStr(q4.abonoPecuniarioFerias + q4.feriasEmDobroArt137)}</td></tr>
<tr><td>04. Indenizações por rescisão de contrato de trabalho / FGTS / Salário-Família</td><td align="right">R$ ${formatMoneyBrStr(q4.indenizacaoRescisaoFgtsAviso + q4.salarioFamilia)}</td></tr>
<tr><td>07. Outros isentos (Total do Quadro 4: R$ ${formatMoneyBrStr(q4.totalIsentos)})</td><td align="right">R$ ${formatMoneyBrStr(q4.outrosIsentos)}</td></tr>
</table>
<table border="1" cellpadding="6" cellspacing="0" width="100%" style="border-collapse:collapse;margin-bottom:12px;">
<tr><th colspan="2" align="left" style="background:#f1f5f9;">5. RENDIMENTOS SUJEITOS À TRIBUTAÇÃO EXCLUSIVA (RENDIMENTO LÍQUIDO)</th></tr>
<tr><td>01. Décimo terceiro salário (Líquido Quadro 5 | Bruto: R$ ${formatMoneyBrStr(q5.decimoTerceiroBruto)})</td><td align="right">R$ ${formatMoneyBrStr(q5.decimoTerceiroLiquidoQuadro)}</td></tr>
<tr><td>02. IRRF sobre décimo terceiro salário</td><td align="right">R$ ${formatMoneyBrStr(q5.irrfSobreDecimoTerceiro)}</td></tr>
<tr><td>03. Outros (PLR líquido | Bruto R$ ${formatMoneyBrStr(q5.plrBruto)} / IRRF R$ ${formatMoneyBrStr(q5.irrfSobrePlr)})</td><td align="right">R$ ${formatMoneyBrStr(q5.outrosExclusiva)}</td></tr>
</table>
<table border="1" cellpadding="6" cellspacing="0" width="100%" style="border-collapse:collapse;margin-bottom:12px;">
<tr><th colspan="2" align="left" style="background:#f1f5f9;">6. RENDIMENTOS RECEBIDOS ACUMULADAMENTE - RRA (Art. 12-A da Lei nº 7.713/88)</th></tr>
<tr><td>6.1 Número do Processo/Acordo: ${q6.numeroProcessoOuAcordo || '-'} | Quantidade de meses: ${q6.quantidadeMeses}</td><td align="right">Rendimentos: R$ ${formatMoneyBrStr(q6.rendimentosTributaveis)}</td></tr>
<tr><td>Exclusões (Previdência R$ ${formatMoneyBrStr(q6.exclusaoPrevidenciaOficial)} | Pensão R$ ${formatMoneyBrStr(q6.exclusaoPensaoAlimenticia)})</td><td align="right">IRRF RRA: R$ ${formatMoneyBrStr(q6.impostoRetidoFonte)}</td></tr>
</table>
<div style="border:1px solid #000;padding:8px;"><strong>7. INFORMAÇÕES COMPLEMENTARES (Pensão Judicial e Planos de Saúde ANS)</strong>${compLines}</div>
</body></html>`;
  }
}
