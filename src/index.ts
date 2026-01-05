import { config as loadEnv } from 'dotenv';
import { createServer } from 'http';
import { loadConfig } from './config/index.js';
import { initSupabase } from './lib/supabase.js';
import { WorkerManager } from './services/worker-manager.js';
import { logger } from './lib/logger.js';

loadEnv();

process.on('uncaughtException', (error) => {
  logger.fatal({ error }, 'Uncaught exception, exiting');
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.fatal({ reason, promise }, 'Unhandled rejection, exiting');
  process.exit(1);
});

function startHealthCheckServer(workerId: string, mode: string) {
  const port = parseInt(process.env.PORT || '8080', 10);

  const server = createServer((req, res) => {
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'healthy',
        workerId,
        mode,
        timestamp: new Date().toISOString()
      }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  });

  server.listen(port, '0.0.0.0', () => {
    logger.info({ port }, 'Health check server listening');
  });

  return server;
}

async function main() {
  try {
    logger.info('LiveKit Media Worker starting');

    const config = loadConfig();

    logger.info(
      {
        workerId: config.workerId,
        mode: config.mode,
        pollingInterval: config.pollingIntervalMs,
        heartbeatInterval: config.heartbeatIntervalMs,
      },
      'Worker configuration loaded'
    );

    initSupabase(config);
    logger.info('Supabase client initialized');

    startHealthCheckServer(config.workerId, config.mode);

    const workerManager = new WorkerManager(config);
    await workerManager.start();
  } catch (error) {
    logger.error({ error }, 'Fatal error during worker startup');
    process.exit(1);
  }
}

main();
