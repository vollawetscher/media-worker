import { AudioStreamManager } from './audio-stream-manager.js';
export interface LiveKitServerConfig {
    server_url: string;
    api_key: string;
    api_secret: string;
}
export declare class LiveKitRoomClient {
    private room;
    private roomId;
    private roomName;
    private workerId;
    private serverConfig;
    private audioStreamManager;
    private participantMap;
    private onParticipantCountChange?;
    constructor(roomId: string, roomName: string, workerId: string, serverConfig: LiveKitServerConfig, audioStreamManager: AudioStreamManager);
    setParticipantCountChangeHandler(handler: (count: number) => void): void;
    connect(): Promise<void>;
    private generateWorkerToken;
    private handleParticipantConnected;
    private handleParticipantDisconnected;
    private handleTrackSubscribed;
    private createOrUpdateParticipant;
    private notifyParticipantCountChange;
    getHumanParticipantCount(): number;
    disconnect(): Promise<void>;
    isConnected(): boolean;
}
//# sourceMappingURL=livekit-room.d.ts.map