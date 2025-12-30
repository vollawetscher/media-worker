import { v4 as uuidv4 } from 'uuid';
function parseCommandLineArgs() {
    const args = process.argv.slice(2);
    const parsed = {};
    for (const arg of args) {
        if (arg.startsWith('--mode=')) {
            const mode = arg.substring(7);
            if (['transcription', 'ai-jobs', 'both'].includes(mode)) {
                parsed.mode = mode;
            }
        }
    }
    return parsed;
}
export function loadConfig() {
    const requiredEnvVars = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
    for (const envVar of requiredEnvVars) {
        if (!process.env[envVar]) {
            throw new Error(`Missing required environment variable: ${envVar}`);
        }
    }
    const cliArgs = parseCommandLineArgs();
    const mode = (cliArgs.mode || process.env.MODE || 'transcription');
    if (!['transcription', 'ai-jobs', 'both'].includes(mode)) {
        throw new Error(`Invalid MODE: ${mode}. Must be 'transcription', 'ai-jobs', or 'both'`);
    }
    return {
        workerId: process.env.WORKER_ID || uuidv4(),
        mode,
        pollingIntervalMs: parseInt(process.env.POLLING_INTERVAL_MS || '3000', 10),
        heartbeatIntervalMs: parseInt(process.env.HEARTBEAT_INTERVAL_MS || '15000', 10),
        supabase: {
            url: process.env.SUPABASE_URL,
            serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        },
        logging: {
            level: process.env.LOG_LEVEL || 'info',
        },
    };
}
//# sourceMappingURL=index.js.map