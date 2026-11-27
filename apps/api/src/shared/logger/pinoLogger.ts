import { FastifyServerOptions } from 'fastify';
import { env } from '../../config/env.js';

/**
 * Lista de caminhos de dados sensíveis e PII protegidos pela LGPD (Lei 13.709/2018).
 * Qualquer ocorrência dessas chaves nos logs é censurada automaticamente pelo Pino.
 */
export const LGPD_REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.body.password',
  'req.body.currentPassword',
  'req.body.newPassword',
  'req.body.token',
  'req.body.refreshToken',
  'req.body.accessToken',
  'req.body.totpSecret',
  'req.body.totpCode',
  'req.body.cpf',
  'req.body.pis',
  'req.body.pis_pasep',
  'req.body.rg',
  'req.body.cnh',
  'req.body.cid',
  'req.body.cid10',
  'req.body.medicalDiagnosis',
  'req.body.baseSalary',
  'req.body.base_salary',
  'req.body.bankAccount',
  'req.body.pixKey',
  'req.body.certificate_password',
  'req.body.certificatePassword',
  'req.body.pfx_base64',
  'req.body.pfxBase64',
  'req.body.encrypted_pfx_envelope',
  'req.body.keyPem',
  'req.body.privateKey',
  '*.password',
  '*.currentPassword',
  '*.newPassword',
  '*.certificate_password',
  '*.certificatePassword',
  '*.pfx_base64',
  '*.pfxBase64',
  '*.encrypted_pfx_envelope',
  '*.keyPem',
  '*.privateKey',
  '*.token',
  '*.refreshToken',
  '*.totpSecret',
  '*.cpf',
  '*.pis',
  '*.cid',
  '*.cid10',
];

export const pinoLoggerConfig: FastifyServerOptions['logger'] = env.NODE_ENV === 'test'
  ? false
  : {
      level: env.LOG_LEVEL,
      redact: {
        paths: LGPD_REDACTED_PATHS,
        censor: '[DADO PROTEGIDO LGPD]',
      },
      serializers: {
        req(request: any) {
          return {
            method: request.method,
            url: request.url,
            path: request.routeOptions?.url || request.url,
            parameters: request.params,
            headers: {
              host: request.headers?.host,
              'user-agent': request.headers?.['user-agent'],
            },
          };
        },
      },
      ...(env.NODE_ENV === 'development'
        ? {
            transport: {
              target: 'pino-pretty',
              options: {
                translateTime: 'HH:MM:ss Z',
                ignore: 'pid,hostname',
              },
            },
          }
        : {}),
    };
