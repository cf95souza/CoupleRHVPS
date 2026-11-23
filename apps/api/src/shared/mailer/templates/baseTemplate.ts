export interface BaseTemplateOptions {
  title: string;
  preheader?: string;
  contentHtml: string;
  actionUrl?: string;
  actionLabel?: string;
  footerNote?: string;
}

export function renderBaseEmailTemplate(options: BaseTemplateOptions): string {
  const { title, preheader, contentHtml, actionUrl, actionLabel, footerNote } = options;

  const preheaderHtml = preheader
    ? `<div style="display: none; max-height: 0px; overflow: hidden; mso-hide: all;">${preheader}</div>`
    : '';

  const actionButtonHtml = actionUrl && actionLabel
    ? `
      <div style="margin: 32px 0; text-align: center;">
        <!--[if mso]>
        <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${actionUrl}" style="height:48px;v-text-anchor:middle;width:240px;" arcsize="10%" strokecolor="#1e3a8a" fillcolor="#1e3a8a">
          <w:anchorlock/>
          <center style="color:#ffffff;font-family:sans-serif;font-size:16px;font-weight:bold;">${actionLabel}</center>
        </v:roundrect>
        <![endif]-->
        <a href="${actionUrl}" style="background-color: #1e3a8a; border-radius: 6px; color: #ffffff; display: inline-block; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 15px; font-weight: 600; line-height: 48px; text-align: center; text-decoration: none; width: 240px; -webkit-text-size-adjust: none; mso-hide: all; box-shadow: 0 2px 4px rgba(30, 58, 138, 0.2);">
          ${actionLabel}
        </a>
      </div>
      <p style="font-size: 12px; color: #64748b; text-align: center; margin-top: 8px;">
        Ou copie e cole o seguinte link no seu navegador:<br>
        <a href="${actionUrl}" style="color: #2563eb; word-break: break-all;">${actionUrl}</a>
      </p>
    `
    : '';

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased; color: #1e293b;">
  ${preheaderHtml}
  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #f8fafc; padding: 40px 16px;">
    <tr>
      <td align="center">
        <!-- Container Principal -->
        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 600px; background-color: #ffffff; border-radius: 8px; overflow: hidden; border: 1px solid #e2e8f0; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);">
          <!-- Header Corporativo -->
          <tr>
            <td style="background-color: #0f172a; padding: 24px 32px; text-align: left; border-bottom: 3px solid #3b82f6;">
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td>
                    <span style="color: #ffffff; font-size: 20px; font-weight: 700; letter-spacing: -0.5px;">Couple<span style="color: #38bdf8;">RH</span></span>
                    <span style="color: #94a3b8; font-size: 11px; margin-left: 8px; text-transform: uppercase; letter-spacing: 1px; font-weight: 500;">Enterprise</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Corpo do E-mail -->
          <tr>
            <td style="padding: 36px 32px 24px 32px;">
              <h1 style="color: #0f172a; font-size: 20px; font-weight: 700; margin-top: 0; margin-bottom: 20px; line-height: 1.3;">
                ${title}
              </h1>
              <div style="color: #334155; font-size: 15px; line-height: 1.6;">
                ${contentHtml}
              </div>
              ${actionButtonHtml}
            </td>
          </tr>

          <!-- Footer e Mensagens Legais -->
          <tr>
            <td style="background-color: #f1f5f9; padding: 24px 32px; border-top: 1px solid #e2e8f0; text-align: center; color: #64748b; font-size: 12px; line-height: 1.5;">
              ${footerNote ? `<p style="margin: 0 0 12px 0;">${footerNote}</p>` : ''}
              <p style="margin: 0 0 6px 0; font-weight: 500; color: #475569;">
                CoupleRH Enterprise — Gestão Inteligente de RH, Folha e Ponto CLT
              </p>
              <p style="margin: 0; color: #94a3b8; font-size: 11px;">
                Este é um e-mail automático gerado pelo sistema. Por motivos de segurança, por favor não responda a esta mensagem.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
