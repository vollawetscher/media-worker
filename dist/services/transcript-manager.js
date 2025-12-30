import { getSupabase } from '../lib/supabase.js';
import { createLogger } from '../lib/logger.js';
const logger = createLogger({ component: 'TranscriptManager' });
export class TranscriptManager {
    roomId;
    timebase;
    batchQueue = [];
    batchTimer = null;
    BATCH_SIZE = 10;
    BATCH_INTERVAL_MS = 100;
    constructor(roomId, timebase) {
        this.roomId = roomId;
        this.timebase = timebase;
    }
    async writeTranscript(data) {
        if (!data.isFinal) {
            return;
        }
        this.batchQueue.push({ ...data, timestamp: new Date() });
        if (this.batchQueue.length >= this.BATCH_SIZE) {
            await this.flush();
        }
        else if (!this.batchTimer) {
            this.batchTimer = setTimeout(() => this.flush(), this.BATCH_INTERVAL_MS);
        }
    }
    async flush() {
        if (this.batchTimer) {
            clearTimeout(this.batchTimer);
            this.batchTimer = null;
        }
        if (this.batchQueue.length === 0) {
            return;
        }
        const batch = [...this.batchQueue];
        this.batchQueue = [];
        const supabase = getSupabase();
        const records = batch.map((item) => {
            const relativeTimestamp = this.timebase.getRelativeTime(item.timestamp);
            return {
                room_id: this.roomId,
                speechmatics_session_id: item.speechmaticsSessionId,
                participant_id: item.participantId,
                transcript_text: item.text,
                is_final: item.isFinal,
                confidence: item.confidence,
                relative_timestamp: relativeTimestamp,
                start_time: item.startTime,
                end_time: item.endTime,
                language: item.language || 'en',
                timestamp: item.timestamp.toISOString(),
                metadata: item.metadata || {},
            };
        });
        const { error } = await supabase.from('transcriptions').insert(records);
        if (error) {
            logger.error({ error, batchSize: records.length }, 'Failed to insert transcript batch');
            this.batchQueue.unshift(...batch);
            throw error;
        }
        logger.debug({ count: records.length, roomId: this.roomId }, 'Successfully wrote transcript batch');
    }
    async stop() {
        await this.flush();
    }
}
//# sourceMappingURL=transcript-manager.js.map