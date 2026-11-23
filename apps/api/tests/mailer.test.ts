import { describe, it, expect, vi } from 'vitest';
import nodemailer from 'nodemailer';
import { MailerService } from '../src/shared/mailer/MailerService.js';
import { QueueService, SendEmailJobData } from '../src/shared/queue/QueueService.js';
import {
  buildWelcomeEmployeeEmail,
  buildPasswordResetEmail,
  buildPayslipAvailableEmail,
  buildVacationAlertEmail,
  buildTimePunchClosingEmail,
} from '../src/shared/mailer/templates/emailTemplates.js';

describe('Templates de E-mail Corporativos (PT-BR e Conformidade CLT)', () => {
  it('1. buildWelcomeEmployeeEmail deve gerar assunto, HTML e texto de boas-vindas com dados mascarados', () => {
    const rendered = buildWelcomeEmployeeEmail({
      employeeName: 'Carlos Eduardo Souza',
      companyName: 'TechCorp Brasil Ltda',
      activationUrl: 'https://app.couplerh.com.br/ativar?token=xyz123',
      loginCpfMasked: '***.456.789-**',
    });

    expect(rendered.subject).toBe('[CoupleRH] Bem-vindo(a) à TechCorp Brasil Ltda — Ative seu Portal do Colaborador');
    expect(rendered.html).toContain('Carlos Eduardo Souza');
    expect(rendered.html).toContain('TechCorp Brasil Ltda');
    expect(rendered.html).toContain('***.456.789-**');
    expect(rendered.html).toContain('https://app.couplerh.com.br/ativar?token=xyz123');
    expect(rendered.html).toContain('Ativar Meu Acesso');
    expect(rendered.html).toContain('48 horas');

    expect(rendered.text).toContain('Carlos Eduardo Souza');
    expect(rendered.text).toContain('TechCorp Brasil Ltda');
    expect(rendered.text).toContain('***.456.789-**');
    expect(rendered.text).toContain('https://app.couplerh.com.br/ativar?token=xyz123');
  });

  it('2. buildPasswordResetEmail deve gerar instruções seguras de redefinição com expiração', () => {
    const rendered = buildPasswordResetEmail({
      userName: 'Mariana Lima',
      resetUrl: 'https://app.couplerh.com.br/redefinir-senha?token=abc789',
      expiresInMinutes: 30,
    });

    expect(rendered.subject).toBe('[CoupleRH] Redefinição de Senha de Acesso');
    expect(rendered.html).toContain('Mariana Lima');
    expect(rendered.html).toContain('https://app.couplerh.com.br/redefinir-senha?token=abc789');
    expect(rendered.html).toContain('Redefinir Minha Senha');
    expect(rendered.html).toContain('30 minutos');

    expect(rendered.text).toContain('Mariana Lima');
    expect(rendered.text).toContain('30 minutos');
  });

  it('3. buildPayslipAvailableEmail deve suportar visualização e download direto com PDF', () => {
    // Com downloadUrl
    const withDownload = buildPayslipAvailableEmail({
      employeeName: 'João Santos',
      competenceMonthYear: '05/2026',
      companyName: 'Acme Engenharia',
      portalUrl: 'https://app.couplerh.com.br/portal/holerites',
      downloadUrl: 'https://app.couplerh.com.br/api/v1/storage/download/holerite-123.pdf',
    });

    expect(withDownload.subject).toBe('[CoupleRH] Seu Holerite de 05/2026 está disponível');
    expect(withDownload.html).toContain('João Santos');
    expect(withDownload.html).toContain('05/2026');
    expect(withDownload.html).toContain('Acme Engenharia');
    expect(withDownload.html).toContain('Baixar Holerite (PDF)');
    expect(withDownload.html).toContain('https://app.couplerh.com.br/api/v1/storage/download/holerite-123.pdf');

    // Sem downloadUrl (fallback portal)
    const portalOnly = buildPayslipAvailableEmail({
      employeeName: 'João Santos',
      competenceMonthYear: '05/2026',
      companyName: 'Acme Engenharia',
      portalUrl: 'https://app.couplerh.com.br/portal/holerites',
    });
    expect(portalOnly.html).toContain('Acessar Meu Holerite');
    expect(portalOnly.html).toContain('https://app.couplerh.com.br/portal/holerites');
  });

  it('4. buildVacationAlertEmail deve destacar criticidade legal (Art. 137 CLT) e prazos', () => {
    // Caso Crítico <= 60 dias
    const critical = buildVacationAlertEmail({
      managerName: 'Roberta Gestora',
      employeeName: 'Lucas Ferreira',
      companyName: 'Indústria ABC',
      acquisitionPeriod: '01/03/2024 a 28/02/2025',
      concessiveLimitDate: '28/01/2026',
      daysRemaining: 45,
      portalActionUrl: 'https://app.couplerh.com.br/ferias/programar/lucas',
    });

    expect(critical.subject).toBe('[ALERTA DE FÉRIAS] Prazo concessivo de Lucas Ferreira expira em 45 dias');
    expect(critical.html).toContain('Roberta Gestora');
    expect(critical.html).toContain('Lucas Ferreira');
    expect(critical.html).toContain('Art. 137');
    expect(critical.html).toContain('45 dias');
    expect(critical.html).toContain('#dc2626'); // Vermelho crítico
    expect(critical.html).toContain('Programar Férias no Sistema');

    // Caso de Alerta Normal > 60 dias
    const warning = buildVacationAlertEmail({
      managerName: 'Roberta Gestora',
      employeeName: 'Lucas Ferreira',
      companyName: 'Indústria ABC',
      acquisitionPeriod: '01/03/2024 a 28/02/2025',
      concessiveLimitDate: '28/01/2026',
      daysRemaining: 90,
      portalActionUrl: 'https://app.couplerh.com.br/ferias/programar/lucas',
    });
    expect(warning.html).toContain('#ea580c'); // Laranja aviso
  });

  it('5. buildTimePunchClosingEmail deve mencionar Portaria MTP 671/2021 e prazo de assinatura', () => {
    const rendered = buildTimePunchClosingEmail({
      employeeName: 'Patrícia Oliveira',
      competenceMonthYear: 'Abril/2026',
      reviewUrl: 'https://app.couplerh.com.br/ponto/espelho/2026-04',
      deadlineDate: '05/05/2026',
    });

    expect(rendered.subject).toBe('[Ponto Eletrônico] Conferência e Assinatura do Espelho de Abril/2026');
    expect(rendered.html).toContain('Patrícia Oliveira');
    expect(rendered.html).toContain('Abril/2026');
    expect(rendered.html).toContain('05/05/2026');
    expect(rendered.html).toContain('Portaria MTP 671/2021');
    expect(rendered.html).toContain('Conferir e Assinar Espelho');
  });
});

describe('MailerService - Envio Direto e Integração com Templates', () => {
  const jsonTransporter = nodemailer.createTransport({
    jsonTransport: true,
  });

  const mailer = new MailerService({
    transporter: jsonTransporter,
  });

  it('deve realizar envio direto síncrono com remetente padrão e anexos', async () => {
    const result = await mailer.sendDirect({
      to: 'colaborador@empresa.com.br',
      subject: 'Teste de Envio Direto',
      html: '<h1>Olá Mundo</h1>',
      text: 'Olá Mundo',
    });

    expect(result.messageId).toBeDefined();
    expect(result.response).toBeDefined();

    const sentMessage = typeof result.response === 'string' ? JSON.parse(result.response) : result.response;
    expect(sentMessage.to[0].address).toBe('colaborador@empresa.com.br');
    expect(sentMessage.subject).toBe('Teste de Envio Direto');
    expect(sentMessage.html).toBe('<h1>Olá Mundo</h1>');
  });

  it('deve executar sendWelcomeEmployee em modo direto sem falhas', async () => {
    const result = await mailer.sendWelcomeEmployee(
      'novo.colaborador@empresa.com.br',
      {
        employeeName: 'Ana Beatriz',
        companyName: 'Global Serv',
        activationUrl: 'https://app.couplerh.com.br/ativar?t=123',
        loginCpfMasked: '***.123.456-**',
      },
      false // async = false -> direct
    );

    expect(result.queued).toBe(false);
  });

  it('deve executar sendPasswordReset em modo direto de alta prioridade', async () => {
    const result = await mailer.sendPasswordReset(
      'seguranca@empresa.com.br',
      {
        userName: 'Gestor Seguro',
        resetUrl: 'https://app.couplerh.com.br/reset?token=xyz',
      },
      false
    );

    expect(result.queued).toBe(false);
  });

  it('deve executar sendPayslipAvailable em modo direto', async () => {
    const result = await mailer.sendPayslipAvailable(
      'financeiro@empresa.com.br',
      {
        employeeName: 'Bruno Alencar',
        competenceMonthYear: '04/2026',
        companyName: 'Corp XYZ',
        portalUrl: 'https://app.couplerh.com.br/holerites',
      },
      false
    );

    expect(result.queued).toBe(false);
  });

  it('deve executar sendVacationAlert em modo direto', async () => {
    const result = await mailer.sendVacationAlert(
      'rh@empresa.com.br',
      {
        managerName: 'Diretor Silva',
        employeeName: 'Colaborador Férias',
        companyName: 'Corp XYZ',
        acquisitionPeriod: '2024-2025',
        concessiveLimitDate: '15/12/2025',
        daysRemaining: 25,
        portalActionUrl: 'https://app.couplerh.com.br/ferias',
      },
      false
    );

    expect(result.queued).toBe(false);
  });

  it('deve executar sendTimePunchClosing em modo direto', async () => {
    const result = await mailer.sendTimePunchClosing(
      'operacao@empresa.com.br',
      {
        employeeName: 'Operador 1',
        competenceMonthYear: '05/2026',
        reviewUrl: 'https://app.couplerh.com.br/espelho',
        deadlineDate: '02/06/2026',
      },
      false
    );

    expect(result.queued).toBe(false);
  });
});

describe('MailerService - Resiliência e Fila Assíncrona (pg-boss)', () => {
  it('deve fazer fallback automático para sendDirect quando a fila pg-boss não estiver ativa', async () => {
    const jsonTransporter = nodemailer.createTransport({ jsonTransport: true });
    const mockInactiveQueue = {
      isRunning: false,
      enqueueEmail: vi.fn(),
    } as unknown as QueueService;

    const mailerWithInactiveQueue = new MailerService({
      transporter: jsonTransporter,
      queueService: mockInactiveQueue,
    });

    const result = await mailerWithInactiveQueue.sendQueued({
      to: 'fallback@empresa.com.br',
      subject: 'Fallback Direto',
      html: '<p>Fallback Seguro</p>',
    });

    expect(result.queued).toBe(false);
    expect(mockInactiveQueue.enqueueEmail).not.toHaveBeenCalled();
  });

  it('deve enfileirar com sucesso quando a fila pg-boss estiver ativa', async () => {
    const jsonTransporter = nodemailer.createTransport({ jsonTransport: true });
    const mockActiveQueue = {
      isRunning: true,
      enqueueEmail: vi.fn().mockResolvedValue('boss-job-uuid-999'),
    } as unknown as QueueService;

    const mailerWithActiveQueue = new MailerService({
      transporter: jsonTransporter,
      queueService: mockActiveQueue,
    });

    const result = await mailerWithActiveQueue.sendQueued({
      to: 'enfileirado@empresa.com.br',
      subject: 'Envio na Fila',
      html: '<p>Processamento Assíncrono</p>',
    });

    expect(result.queued).toBe(true);
    expect(result.jobId).toBe('boss-job-uuid-999');
    expect(mockActiveQueue.enqueueEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'enfileirado@empresa.com.br',
        subject: 'Envio na Fila',
      })
    );
  });
});
