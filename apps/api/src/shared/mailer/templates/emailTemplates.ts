import { renderBaseEmailTemplate } from './baseTemplate.js';

export interface EmailRenderResult {
  subject: string;
  html: string;
  text: string;
}

/**
 * 1. Template de Boas-Vindas e Primeiro Acesso do Colaborador
 */
export function buildWelcomeEmployeeEmail(data: {
  employeeName: string;
  companyName: string;
  activationUrl: string;
  loginCpfMasked: string;
}): EmailRenderResult {
  const title = `Bem-vindo(a) à ${data.companyName}!`;
  const subject = `[CoupleRH] Bem-vindo(a) à ${data.companyName} — Ative seu Portal do Colaborador`;

  const contentHtml = `
    <p>Olá, <strong>${data.employeeName}</strong>,</p>
    <p>Seu cadastro na <strong>${data.companyName}</strong> foi concluído com sucesso no CoupleRH!</p>
    <p>A partir de agora, você tem acesso ao <strong>Portal do Colaborador</strong>, onde poderá:</p>
    <ul style="padding-left: 20px; line-height: 1.8;">
      <li>Registrar suas marcações de ponto eletrônico com geolocalização e espelho diário;</li>
      <li>Consultar e baixar seus holerites, informes e recibos de pagamento;</li>
      <li>Assinar digitalmente contratos, termos e recibos;</li>
      <li>Solicitar férias e enviar atestados médicos com rapidez e segurança.</li>
    </ul>
    <div style="background-color: #f8fafc; border-left: 4px solid #3b82f6; padding: 12px 16px; margin: 20px 0; border-radius: 4px;">
      <p style="margin: 0; font-size: 14px; color: #334155;">
        <strong>Seu identificador de acesso:</strong> CPF ${data.loginCpfMasked}
      </p>
    </div>
    <p>Clique no botão abaixo para criar sua senha de acesso e ativar sua conta:</p>
  `;

  const html = renderBaseEmailTemplate({
    title,
    preheader: `Ative seu acesso ao Portal do Colaborador na ${data.companyName}`,
    contentHtml,
    actionUrl: data.activationUrl,
    actionLabel: 'Ativar Meu Acesso',
    footerNote: 'Por segurança, este link de ativação expira em 48 horas.',
  });

  const text = `Olá, ${data.employeeName}!\n\nSeu cadastro na ${data.companyName} foi concluído no CoupleRH. Para ativar seu acesso e definir sua senha, acesse o link:\n${data.activationUrl}\n\nIdentificador de acesso: CPF ${data.loginCpfMasked}\n\nEste link expira em 48 horas.`;

  return { subject, html, text };
}

/**
 * 2. Template de Redefinição de Senha
 */
export function buildPasswordResetEmail(data: {
  userName: string;
  resetUrl: string;
  expiresInMinutes?: number;
}): EmailRenderResult {
  const minutes = data.expiresInMinutes || 15;
  const title = 'Solicitação de Redefinição de Senha';
  const subject = '[CoupleRH] Redefinição de Senha de Acesso';

  const contentHtml = `
    <p>Olá, <strong>${data.userName}</strong>,</p>
    <p>Recebemos uma solicitação para redefinir a senha da sua conta no sistema CoupleRH.</p>
    <p>Se você realizou esta solicitação, clique no botão abaixo para cadastrar sua nova senha:</p>
  `;

  const html = renderBaseEmailTemplate({
    title,
    preheader: `Redefina sua senha de acesso ao CoupleRH (Expira em ${minutes} minutos)`,
    contentHtml,
    actionUrl: data.resetUrl,
    actionLabel: 'Redefinir Minha Senha',
    footerNote: `Este link de segurança é de uso único e expira em ${minutes} minutos. Se você não solicitou a alteração, ignore este e-mail; sua senha atual permanece segura.`,
  });

  const text = `Olá, ${data.userName}!\n\nRecebemos uma solicitação para redefinir sua senha no CoupleRH. Para prosseguir, acesse o link:\n${data.resetUrl}\n\nEste link expira em ${minutes} minutos. Se você não solicitou, ignore esta mensagem.`;

  return { subject, html, text };
}

/**
 * 3. Template de Holerite Disponibilizado
 */
export function buildPayslipAvailableEmail(data: {
  employeeName: string;
  competenceMonthYear: string;
  companyName: string;
  portalUrl: string;
  downloadUrl?: string;
}): EmailRenderResult {
  const title = `Recibo de Pagamento Disponível — ${data.competenceMonthYear}`;
  const subject = `[CoupleRH] Seu Holerite de ${data.competenceMonthYear} está disponível`;

  const contentHtml = `
    <p>Olá, <strong>${data.employeeName}</strong>,</p>
    <p>Informamos que o seu recibo de pagamento referente à competência <strong>${data.competenceMonthYear}</strong> da empresa <strong>${data.companyName}</strong> já foi processado e está disponível para consulta.</p>
    <p>Você pode visualizar o detalhamento de proventos, descontos e tributos (INSS, IRRF e FGTS) diretamente no Portal do Colaborador.</p>
  `;

  const actionUrl = data.downloadUrl || data.portalUrl;
  const actionLabel = data.downloadUrl ? 'Baixar Holerite (PDF)' : 'Acessar Meu Holerite';

  const html = renderBaseEmailTemplate({
    title,
    preheader: `Seu holerite de ${data.competenceMonthYear} já está liberado para consulta e download.`,
    contentHtml,
    actionUrl,
    actionLabel,
    footerNote: 'Mantenha seus recibos guardados com segurança. Seus dados salariais são confidenciais.',
  });

  const text = `Olá, ${data.employeeName}!\n\nSeu recibo de pagamento da competência ${data.competenceMonthYear} (${data.companyName}) já está disponível no Portal do Colaborador.\n\nAcesse pelo link:\n${actionUrl}`;

  return { subject, html, text };
}

/**
 * 4. Template de Alerta Preventivo de Férias / Risco de Dobra Legal (Art. 137 CLT)
 */
export function buildVacationAlertEmail(data: {
  managerName: string;
  employeeName: string;
  companyName: string;
  acquisitionPeriod: string;
  concessiveLimitDate: string;
  daysRemaining: number;
  portalActionUrl: string;
}): EmailRenderResult {
  const isCritical = data.daysRemaining <= 60;
  const statusColor = isCritical ? '#dc2626' : '#ea580c';
  const title = `Alerta de Férias CLT — ${data.employeeName}`;
  const subject = `[ALERTA DE FÉRIAS] Prazo concessivo de ${data.employeeName} expira em ${data.daysRemaining} dias`;

  const contentHtml = `
    <p>Prezado(a) <strong>${data.managerName}</strong>,</p>
    <p>O Radar Trabalhista do CoupleRH identificou a aproximação do limite do período concessivo de férias do colaborador abaixo:</p>
    
    <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 16px; margin: 20px 0;">
      <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
        <tr>
          <td style="padding: 6px 0; color: #64748b; width: 40%;">Colaborador:</td>
          <td style="padding: 6px 0; font-weight: 600; color: #0f172a;">${data.employeeName}</td>
        </tr>
        <tr>
          <td style="padding: 6px 0; color: #64748b;">Empresa:</td>
          <td style="padding: 6px 0; font-weight: 600; color: #0f172a;">${data.companyName}</td>
        </tr>
        <tr>
          <td style="padding: 6px 0; color: #64748b;">Período Aquisitivo:</td>
          <td style="padding: 6px 0; color: #334155;">${data.acquisitionPeriod}</td>
        </tr>
        <tr>
          <td style="padding: 6px 0; color: #64748b;">Data Limite Concessiva:</td>
          <td style="padding: 6px 0; font-weight: 600; color: ${statusColor};">${data.concessiveLimitDate}</td>
        </tr>
        <tr>
          <td style="padding: 6px 0; color: #64748b;">Dias Restantes:</td>
          <td style="padding: 6px 0; font-weight: 700; color: ${statusColor}; font-size: 16px;">${data.daysRemaining} dias</td>
        </tr>
      </table>
    </div>

    <p style="color: #475569; font-size: 14px;">
      <strong>Atenção às regras da CLT (Art. 137):</strong> Férias concedidas após o prazo legal geram a obrigação de pagamento em dobro da remuneração e do terço constitucional. Recomendamos o agendamento prévio com no mínimo 30 dias de aviso prévio ao trabalhador.
    </p>
  `;

  const html = renderBaseEmailTemplate({
    title,
    preheader: `Atenção: Prazo de férias de ${data.employeeName} vence em ${data.concessiveLimitDate}.`,
    contentHtml,
    actionUrl: data.portalActionUrl,
    actionLabel: 'Programar Férias no Sistema',
    footerNote: 'Alerta preventivo gerado pelo módulo de Compliance Trabalhista do CoupleRH.',
  });

  const text = `Prezado(a) ${data.managerName},\n\nAlerta de prazo concessivo de férias para ${data.employeeName} (${data.companyName}).\nData limite: ${data.concessiveLimitDate} (${data.daysRemaining} dias restantes).\n\nPara programar as férias, acesse:\n${data.portalActionUrl}`;

  return { subject, html, text };
}

/**
 * 5. Template de Fechamento de Espelho de Ponto Eletrônico (Portaria MTP 671/2021)
 */
export function buildTimePunchClosingEmail(data: {
  employeeName: string;
  competenceMonthYear: string;
  reviewUrl: string;
  deadlineDate: string;
}): EmailRenderResult {
  const title = `Fechamento do Espelho de Ponto — ${data.competenceMonthYear}`;
  const subject = `[Ponto Eletrônico] Conferência e Assinatura do Espelho de ${data.competenceMonthYear}`;

  const contentHtml = `
    <p>Olá, <strong>${data.employeeName}</strong>,</p>
    <p>O espelho de ponto referente ao período de <strong>${data.competenceMonthYear}</strong> foi fechado pelo Departamento Pessoal e está disponível para a sua conferência e assinatura eletrônica.</p>
    <p>Por favor, revise suas marcações, horas extras, atrasos e justificativas aprovadas.</p>
    <div style="background-color: #fef3c7; border-left: 4px solid #f59e0b; padding: 12px 16px; margin: 20px 0; border-radius: 4px;">
      <p style="margin: 0; font-size: 14px; color: #92400e;">
        <strong>Prazo limite para assinatura:</strong> ${data.deadlineDate}
      </p>
    </div>
    <p>Em conformidade com a Portaria MTP 671/2021, a assinatura do espelho de ponto atesta a regularidade das marcações registradas no REP-P.</p>
  `;

  const html = renderBaseEmailTemplate({
    title,
    preheader: `Espelho de ponto de ${data.competenceMonthYear} disponível para conferência e assinatura.`,
    contentHtml,
    actionUrl: data.reviewUrl,
    actionLabel: 'Conferir e Assinar Espelho',
    footerNote: 'Se houver alguma divergência nas marcações, utilize o botão de contestação no próprio Portal.',
  });

  const text = `Olá, ${data.employeeName}!\n\nSeu espelho de ponto de ${data.competenceMonthYear} está pronto para conferência e assinatura eletrônica.\nPrazo limite: ${data.deadlineDate}.\n\nAcesse para conferir:\n${data.reviewUrl}`;

  return { subject, html, text };
}
