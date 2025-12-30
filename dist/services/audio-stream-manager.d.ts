import { RemoteTrack, RemoteParticipant } from '@livekit/rtc-node';
import { SpeechmaticsConfig } from './speechmatics.js';
import { TranscriptManager } from './transcript-manager.js';
export declare class AudioStreamManager {
    private roomId;
    private speechmaticsConfig;
    private transcriptManager;
    private activeSessions;
    private audioProcessors;
    constructor(roomId: string, speechmaticsConfig: SpeechmaticsConfig, transcriptManager: TranscriptManager);
    handleParticipantTrack(participant: RemoteParticipant, track: RemoteTrack, participantId: string): Promise<void>;
    handleParticipantDisconnected(participantIdentity: string): Promise<void>;
    stopSession(sessionKey: string): Promise<void>;
    stopAll(): Promise<void>;
    getActiveSessionCount(): number;
}
//# sourceMappingURL=audio-stream-manager.d.ts.map