export declare class AIJobProcessor {
    private workerId;
    private pollingIntervalMs;
    private isRunning;
    private pollingTimer;
    constructor(workerId: string, pollingIntervalMs?: number);
    start(): Promise<void>;
    stop(): void;
    private poll;
    private processNextJob;
    private claimNextJob;
    private processJob;
    private buildPrompt;
    private callAI;
    private callOpenAI;
    private callAnthropic;
    private loadAIConfigs;
    private logAIInteraction;
    private updateJobStatus;
    private completeJob;
    private failJob;
}
//# sourceMappingURL=ai-job-processor.d.ts.map