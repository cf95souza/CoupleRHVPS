import { buildApp } from './app.js';
import { env } from './config/env.js';

async function main() {
  const app = await buildApp();

  const closeListeners = ['SIGINT', 'SIGTERM'];
  closeListeners.forEach((signal) => {
    process.on(signal, async () => {
      app.log.info({ signal }, 'Sinal de encerramento recebido. Fechando aplicacao graciosamente...');
      await app.close();
      process.exit(0);
    });
  });

  try {
    await app.listen({ port: env.PORT, host: env.HOST });
    app.log.info(`[SERVER] coupleRH API v2.0 executando em http://${env.HOST}:${env.PORT}`);
  } catch (err) {
    app.log.error(err, '[SERVER FATAL] Erro ao iniciar servidor Fastify');
    process.exit(1);
  }
}

main();
