import { getSupabase } from '../lib/supabase.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger({ component: 'PostCallJobScheduler' });

export interface JobDefinition {
  jobType: 'summary' | 'sentiment' | 'action_items' | 'speaker_analytics';
  priority: number;
}

const DEFAULT_JOBS: JobDefinition[] = [
  { jobType: 'summary', priority: 100 },
  { jobType: 'action_items', priority: 90 },
  { jobType: 'sentiment', priority: 70 },
  { jobType: 'speaker_analytics', priority: 50 },
];

export class PostCallJobScheduler {
  private roomId: string;

  constructor(roomId: string) {
    this.roomId = roomId;
  }

  async scheduleJobs(): Promise<void> {
    logger.info({ roomId: this.roomId }, 'Scheduling post-call AI jobs');

    const transcripts = await this.loadTranscripts();
    const participants = await this.loadParticipants();
    const roomMetadata = await this.loadRoomMetadata();

    if (transcripts.length === 0) {
      logger.warn({ roomId: this.roomId }, 'No transcripts found, skipping job creation');
      return;
    }

    const inputData = {
      transcripts: transcripts,
      participants: participants,
      roomMetadata: roomMetadata,
    };

    const supabase = getSupabase();

    const jobsToCreate = DEFAULT_JOBS.map((job) => ({
      room_id: this.roomId,
      job_type: job.jobType,
      priority: job.priority,
      status: 'pending',
      input_data: inputData,
    }));

    const { error } = await supabase.from('post_call_jobs').insert(jobsToCreate);

    if (error) {
      logger.error({ error, roomId: this.roomId }, 'Failed to create post-call jobs');
      throw error;
    }

    logger.info(
      {
        roomId: this.roomId,
        jobCount: jobsToCreate.length,
        transcriptCount: transcripts.length,
      },
      'Successfully scheduled post-call jobs'
    );
  }

  private async loadTranscripts(): Promise<any[]> {
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('transcriptions')
      .select('*')
      .eq('room_id', this.roomId)
      .eq('is_final', true)
      .order('relative_timestamp', { ascending: true });

    if (error) {
      logger.error({ error, roomId: this.roomId }, 'Failed to load transcripts');
      return [];
    }

    return data || [];
  }

  private async loadParticipants(): Promise<any[]> {
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('participants')
      .select('*')
      .eq('room_id', this.roomId);

    if (error) {
      logger.error({ error, roomId: this.roomId }, 'Failed to load participants');
      return [];
    }

    return data || [];
  }

  private async loadRoomMetadata(): Promise<any> {
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('rooms')
      .select('*')
      .eq('id', this.roomId)
      .single();

    if (error) {
      logger.error({ error, roomId: this.roomId }, 'Failed to load room metadata');
      return {};
    }

    return data || {};
  }
}
