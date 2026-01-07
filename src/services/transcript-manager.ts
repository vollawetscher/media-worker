import { getSupabase } from '../lib/supabase.js';
import { Timebase } from '../lib/timebase.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger({ component: 'TranscriptManager' });

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

export class TranscriptManager {
  private roomId: string;
  private timebase: Timebase;
  private batchQueue: Array<TranscriptData & { timestamp: Date }> = [];
  private batchTimer: NodeJS.Timeout | null = null;
  private readonly BATCH_SIZE = 10;
  private readonly BATCH_INTERVAL_MS = 100;
  private readonly MAX_QUEUE_SIZE = 500; // Prevent unbounded growth (prevents memory leak if DB fails)
  private organizationId: string | null = null;
  private droppedTranscriptCount: number = 0;

  constructor(roomId: string, timebase: Timebase) {
    this.roomId = roomId;
    this.timebase = timebase;
  }

  async writeTranscript(data: TranscriptData): Promise<void> {
    if (!data.isFinal) {
      return;
    }

    // Prevent unbounded queue growth - drop oldest transcripts if queue is full
    if (this.batchQueue.length >= this.MAX_QUEUE_SIZE) {
      const dropped = this.batchQueue.shift();
      this.droppedTranscriptCount++;
      logger.warn(
        {
          roomId: this.roomId,
          queueSize: this.batchQueue.length,
          droppedCount: this.droppedTranscriptCount
        },
        'Transcript queue full, dropping oldest transcript'
      );
    }

    this.batchQueue.push({ ...data, timestamp: new Date() });

    if (this.batchQueue.length >= this.BATCH_SIZE) {
      await this.flush();
    } else if (!this.batchTimer) {
      this.batchTimer = setTimeout(() => this.flush(), this.BATCH_INTERVAL_MS);
    }
  }

  async flush(): Promise<void> {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }

    if (this.batchQueue.length === 0) {
      return;
    }

    const batch = [...this.batchQueue];
    this.batchQueue = [];

    if (!this.organizationId) {
      await this.loadOrganizationId();
    }

    if (!this.organizationId) {
      logger.error({ roomId: this.roomId }, 'Cannot flush transcripts: organization_id not found');
      this.batchQueue.unshift(...batch);
      throw new Error('organization_id not found for room');
    }

    const supabase = getSupabase();

    const records = batch.map((item) => {
      const relativeTimestamp = this.timebase.getRelativeTime(item.timestamp);

      return {
        room_id: this.roomId,
        organization_id: this.organizationId,
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

      // Only re-add to queue if we're not near capacity to prevent unbounded growth
      if (this.batchQueue.length + batch.length <= this.MAX_QUEUE_SIZE) {
        this.batchQueue.unshift(...batch);
      } else {
        logger.error(
          {
            roomId: this.roomId,
            currentQueueSize: this.batchQueue.length,
            batchSize: batch.length,
            maxQueueSize: this.MAX_QUEUE_SIZE
          },
          'Cannot re-add failed batch - queue at capacity, transcripts will be lost'
        );
      }

      throw error;
    }

    logger.debug({ count: records.length, roomId: this.roomId }, 'Successfully wrote transcript batch');
  }

  private async loadOrganizationId(): Promise<void> {
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('rooms')
      .select('organization_id')
      .eq('id', this.roomId)
      .single();

    if (error || !data) {
      logger.error({ error, roomId: this.roomId }, 'Failed to load organization_id from room');
      return;
    }

    this.organizationId = data.organization_id;
    logger.debug({ roomId: this.roomId, organizationId: this.organizationId }, 'Loaded organization_id');
  }

  async stop(): Promise<void> {
    await this.flush();
  }
}
