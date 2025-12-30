export interface JobDefinition {
    jobType: 'summary' | 'sentiment' | 'action_items' | 'speaker_analytics';
    priority: number;
}
export declare class PostCallJobScheduler {
    private roomId;
    constructor(roomId: string);
    scheduleJobs(): Promise<void>;
    private consolidateTranscripts;
    private loadTranscripts;
    private loadParticipants;
    private loadRoomMetadata;
}
//# sourceMappingURL=post-call-job-scheduler.d.ts.map