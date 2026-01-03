import { config as loadEnv } from 'dotenv';
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

    const workerManager = new WorkerManager(config);
    await workerManager.start();
  } catch (error) {
    logger.error({ error }, 'Fatal error during worker startup');
    process.exit(1);
  }
}

main();
