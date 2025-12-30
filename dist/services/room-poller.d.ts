export interface Room {
    id: string;
    room_name: string;
    server_id: string;
    status: string;
    ai_enabled: boolean;
    empty_timeout: number;
    transcription_enabled: boolean;
}
export declare class RoomPoller {
    private workerId;
    private pollingIntervalMs;
    private pollingTimer;
    private isPolling;
    constructor(workerId: string, pollingIntervalMs: number);
    start(): Promise<Room>;
    stop(): void;
    private pollForRoom;
    private claimRoom;
}
//# sourceMappingURL=room-poller.d.ts.map