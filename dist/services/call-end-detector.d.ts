export declare class CallEndDetector {
    private roomId;
    private emptyTimeoutSeconds;
    private currentParticipantCount;
    private emptyTimer;
    private onCallEnd?;
    constructor(roomId: string, emptyTimeoutSeconds: number);
    setCallEndHandler(handler: () => void): void;
    updateParticipantCount(count: number): void;
    private startEmptyTimer;
    private cancelEmptyTimer;
    forceCallEnd(): void;
    cleanup(): void;
}
//# sourceMappingURL=call-end-detector.d.ts.map