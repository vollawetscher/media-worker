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
  private organizationId: string | null = null;

  constructor(roomId: string, timebase: Timebase) {
    this.roomId = roomId;
    this.timebase = timebase;
  }

  async writeTranscript(data: TranscriptData): Promise<void> {
    if (!data.isFinal) {
      return;
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
      this.batchQueue.unshift(...batch);
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
