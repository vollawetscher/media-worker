import { Timebase } from '../lib/timebase.js';
export interface TranscriptData {
    speechmaticsSessionId: string;
    participantId: string;
    text: string;
    isFinal: boolean;
    confidence: number;
    startTime?: number;
    endTime?: number;
    language?: string;
    metadata?: Record<string, any>;
}
export declare class TranscriptManager {
    private roomId;
    private timebase;
    private batchQueue;
    private batchTimer;
    private readonly BATCH_SIZE;
    private readonly BATCH_INTERVAL_MS;
    constructor(roomId: string, timebase: Timebase);
    writeTranscript(data: TranscriptData): Promise<void>;
    flush(): Promise<void>;
    stop(): Promise<void>;
}
//# sourceMappingURL=transcript-manager.d.ts.map