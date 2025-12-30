import type { WorkerConfig } from '../config/index.js';
export declare class WorkerManager {
    private config;
    private workerId;
    private currentRoomId;
    private heartbeatInterval;
    private isShuttingDown;
    private roomPoller?;
    private livekitClient?;
    private audioStreamManager?;
    private transcriptManager?;
    private callEndDetector?;
    private aiJobProcessor?;
    private timebase?;
    constructor(config: WorkerConfig);
    start(): Promise<void>;
    private runTranscriptionMode;
    private processRoom;
    private handleCallEnd;
    private registerWorker;
    private startHeartbeat;
    private setupShutdownHandlers;
    private shutdown;
    private releaseRoom;
    private loadSpeechmaticsConfig;
    private loadLiveKitConfig;
}
//# sourceMappingURL=worker-manager.d.ts.map