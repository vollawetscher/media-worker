export interface WorkerConfig {
    workerId: string;
    mode: 'transcription' | 'ai-jobs' | 'both';
    pollingIntervalMs: number;
    heartbeatIntervalMs: number;
    supabase: {
        url: string;
        serviceRoleKey: string;
    };
    logging: {
        level: string;
    };
}
export declare function loadConfig(): WorkerConfig;
//# sourceMappingURL=index.d.ts.map