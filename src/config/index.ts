import { v4 as uuidv4 } from 'uuid';

export interface WorkerConfig {
  workerId: string;
  mode: 'transcription' | 'ai-jobs' | 'both';
  pollingIntervalMs: number;
  heartbeatIntervalMs: number;
  realtimeTimeoutMs: number;
  realtimeRetryIntervalMs: number;
  roomClaimCacheDurationMs: number;
  enablePollingFallback: boolean;
  enableDatabaseNotify: boolean;
  supabase: {
    url: string;
    serviceRoleKey: string;
    databaseUrl?: string;
  };
  logging: {
    level: string;
  };
}

function parseCommandLineArgs(): Partial<WorkerConfig> {
  const args = process.argv.slice(2);
  const parsed: Partial<WorkerConfig> = {};

  for (const arg of args) {
    if (arg.startsWith('--mode=')) {
      const mode = arg.substring(7) as WorkerConfig['mode'];
      if (['transcription', 'ai-jobs', 'both'].includes(mode)) {
        parsed.mode = mode;
      }
    }
  }

  return parsed;
}

export function loadConfig(): WorkerConfig {
  const requiredEnvVars = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];

  for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
      throw new Error(`Missing required environment variable: ${envVar}`);
    }
  }

  const cliArgs = parseCommandLineArgs();
  const mode = (cliArgs.mode || process.env.MODE || 'transcription') as WorkerConfig['mode'];

  if (!['transcription', 'ai-jobs', 'both'].includes(mode)) {
    throw new Error(`Invalid MODE: ${mode}. Must be 'transcription', 'ai-jobs', or 'both'`);
  }

  return {
    workerId: process.env.WORKER_ID || uuidv4(),
    mode,
    pollingIntervalMs: parseInt(process.env.POLLING_INTERVAL_MS || '5000', 10),
    heartbeatIntervalMs: parseInt(process.env.HEARTBEAT_INTERVAL_MS || '15000', 10),
    realtimeTimeoutMs: parseInt(process.env.REALTIME_TIMEOUT_MS || '30000', 10),
    realtimeRetryIntervalMs: parseInt(process.env.REALTIME_RETRY_INTERVAL_MS || '120000', 10),
    roomClaimCacheDurationMs: parseInt(process.env.ROOM_CLAIM_CACHE_DURATION_MS || '30000', 10),
    enablePollingFallback: process.env.ENABLE_POLLING_FALLBACK !== 'false',
    enableDatabaseNotify: process.env.ENABLE_DATABASE_NOTIFY !== 'false',
    supabase: {
      url: process.env.SUPABASE_URL!,
      serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
      databaseUrl: process.env.SUPABASE_DB_URL,
    },
    logging: {
      level: process.env.LOG_LEVEL || 'info',
    },
  };
}
