import type { TranscriptManager } from './transcript-manager.js';
export interface SpeechmaticsConfig {
    apiKey: string;
    language: string;
    enablePartials: boolean;
    operatingPoint: string;
}
export interface SpeechmaticsMessage {
    message: string;
    results?: Array<{
        alternatives: Array<{
            content: string;
            confidence: number;
            language?: string;
        }>;
        start_time?: number;
        end_time?: number;
        type: 'word' | 'punctuation';
    }>;
    metadata?: {
        transcript: string;
        start_time: number;
        end_time: number;
    };
}
export declare class SpeechmaticsStreamClient {
    private ws;
    private sessionId;
    private participantId;
    private roomId;
    private config;
    private transcriptManager;
    private isActive;
    private sessionDbId;
    private transcriptCount;
    private confidenceSum;
    private startTime;
    constructor(roomId: string, participantId: string, config: SpeechmaticsConfig, transcriptManager: TranscriptManager);
    start(): Promise<void>;
    sendAudio(audioData: Buffer): void;
    stop(): Promise<void>;
    private handleMessage;
    private handleTranscript;
    private createSessionRecord;
    private updateSessionStatus;
    private finalizeSessionRecord;
    isRunning(): boolean;
}
//# sourceMappingURL=speechmatics.d.ts.map