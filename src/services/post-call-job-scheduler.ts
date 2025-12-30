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

    const consolidatedTranscripts = this.consolidateTranscripts(transcripts);

    logger.info(
      {
        roomId: this.roomId,
        originalCount: transcripts.length,
        consolidatedCount: consolidatedTranscripts.length,
      },
      'Consolidated transcripts for AI processing'
    );

    const inputData = {
      transcripts: consolidatedTranscripts,
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

  private consolidateTranscripts(transcripts: any[]): any[] {
    if (transcripts.length === 0) {
      return [];
    }

    const consolidated: any[] = [];
    let currentUtterance: any = null;
    const PAUSE_THRESHOLD_SECONDS = 2.0;

    for (const transcript of transcripts) {
      const shouldStartNew =
        !currentUtterance ||
        currentUtterance.participant_id !== transcript.participant_id ||
        transcript.relative_timestamp - currentUtterance.end_timestamp > PAUSE_THRESHOLD_SECONDS;

      if (shouldStartNew) {
        if (currentUtterance) {
          consolidated.push(currentUtterance);
        }

        currentUtterance = {
          participant_id: transcript.participant_id,
          transcript_text: transcript.transcript_text,
          relative_timestamp: transcript.relative_timestamp,
          start_time: transcript.start_time,
          end_time: transcript.end_time,
          end_timestamp: transcript.relative_timestamp + (parseFloat(transcript.end_time) - parseFloat(transcript.start_time)),
        };
      } else {
        currentUtterance.transcript_text += transcript.transcript_text;
        currentUtterance.end_time = transcript.end_time;
        currentUtterance.end_timestamp =
          transcript.relative_timestamp + (parseFloat(transcript.end_time) - parseFloat(transcript.start_time));
      }
    }

    if (currentUtterance) {
      consolidated.push(currentUtterance);
    }

    return consolidated;
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
