export declare class Timebase {
    private t0;
    private roomId;
    constructor(roomId: string);
    initialize(): Promise<void>;
    getRelativeTime(wallClockTime?: Date): number;
    getT0(): Date;
    isInitialized(): boolean;
    convertTimestamp(timestamp: number | Date): number;
}
//# sourceMappingURL=timebase.d.ts.map