import { getSupabase } from '../lib/supabase.js';
import { createLogger } from '../lib/logger.js';
import { Timebase } from '../lib/timebase.js';
import { RoomPoller, Room } from './room-poller.js';
import { TranscriptManager } from './transcript-manager.js';
import { AudioStreamManager } from './audio-stream-manager.js';
import { LiveKitRoomClient, LiveKitServerConfig } from './livekit-room.js';
import { SpeechmaticsConfig } from './speechmatics.js';
import { CallEndDetector } from './call-end-detector.js';
import { AIJobProcessor } from './ai-job-processor.js';
import type { WorkerConfig } from '../config/index.js';

const logger = createLogger({ component: 'WorkerManager' });

export class WorkerManager {
  private config: WorkerConfig;
  private workerId: string;
  private currentRoomId: string | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private isShuttingDown: boolean = false;

  private roomPoller?: RoomPoller;
  private livekitClient?: LiveKitRoomClient;
  private audioStreamManager?: AudioStreamManager;
  private transcriptManager?: TranscriptManager;
  private callEndDetector?: CallEndDetector;
  private aiJobProcessor?: AIJobProcessor;
  private timebase?: Timebase;

  constructor(config: WorkerConfig) {
    this.config = config;
    this.workerId = config.workerId;
  }

  async start(): Promise<void> {
    logger.info({ workerId: this.workerId, mode: this.config.mode }, 'Starting worker');

    await this.cleanupStaleWorkers();
    await this.registerWorker();
    this.startHeartbeat();
    this.startCleanupInterval();
    this.setupShutdownHandlers();

    if (this.config.mode === 'ai-jobs' || this.config.mode === 'both') {
      this.aiJobProcessor = new AIJobProcessor(this.workerId);
      await this.aiJobProcessor.start();
    }

    if (this.config.mode === 'transcription' || this.config.mode === 'both') {
      await this.runTranscriptionMode();
    }
  }

  private async runTranscriptionMode(): Promise<void> {
    while (!this.isShuttingDown) {
      try {
        logger.info('Polling for available rooms');

        this.roomPoller = new RoomPoller(this.workerId, this.config.pollingIntervalMs);
        const room = await this.roomPoller.start();

        logger.info({ roomId: room.id, roomName: room.room_name }, 'Claimed room, starting processing');

        await this.processRoom(room);

        logger.info({ roomId: room.id }, 'Room processing completed');

        this.currentRoomId = null;
      } catch (error) {
        logger.error({ error, roomId: this.currentRoomId }, 'Error in transcription mode');

        if (this.currentRoomId) {
          await this.releaseRoom(this.currentRoomId);
          this.currentRoomId = null;
        }

        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  private async processRoom(room: Room): Promise<void> {
    this.currentRoomId = room.id;

    this.timebase = new Timebase(room.id);
    await this.timebase.initialize();

    this.transcriptManager = new TranscriptManager(room.id, this.timebase);

    const speechmaticsConfig = await this.loadSpeechmaticsConfig();

    this.audioStreamManager = new AudioStreamManager(room.id, speechmaticsConfig, this.transcriptManager);

    const livekitConfig = await this.loadLiveKitConfig(room.server_id);

    this.livekitClient = new LiveKitRoomClient(
      room.id,
      room.room_name,
      this.workerId,
      livekitConfig,
      this.audioStreamManager
    );

    this.callEndDetector = new CallEndDetector(room.id, room.empty_timeout);

    this.callEndDetector.setCallEndHandler(() => {
      this.handleCallEnd();
    });

    this.livekitClient.setParticipantCountChangeHandler((count) => {
      this.callEndDetector?.updateParticipantCount(count);
    });

    await this.livekitClient.connect();

    const initialCount = this.livekitClient.getHumanParticipantCount();
    this.callEndDetector.updateParticipantCount(initialCount);

    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        if (this.isShuttingDown || !this.livekitClient?.isConnected()) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 1000);
    });
  }

  private async handleCallEnd(): Promise<void> {
    logger.info({ roomId: this.currentRoomId }, 'Call ended, starting cleanup');

    try {
      await this.audioStreamManager?.stopAll();

      await this.transcriptManager?.stop();

      await this.livekitClient?.disconnect();

      const supabase = getSupabase();
      await supabase
        .from('rooms')
        .update({
          status: 'completed',
          closed_at: new Date().toISOString(),
        })
        .eq('id', this.currentRoomId!);

      await supabase
        .from('participants')
        .update({
          is_active: false,
          left_at: new Date().toISOString(),
        })
        .eq('room_id', this.currentRoomId!)
        .eq('is_active', true);

      if (this.currentRoomId) {
        await this.releaseRoom(this.currentRoomId);
      }

      logger.info({ roomId: this.currentRoomId }, 'Cleanup completed');
    } catch (error) {
      logger.error({ error, roomId: this.currentRoomId }, 'Error during cleanup');
    }
  }

  private async registerWorker(): Promise<void> {
    const supabase = getSupabase();

    const { error } = await supabase.from('media_workers').insert({
      id: this.workerId,
      status: 'active',
      mode: this.config.mode,
      started_at: new Date().toISOString(),
      last_heartbeat: new Date().toISOString(),
    });

    if (error) {
      throw new Error(`Failed to register worker: ${error.message}`);
    }

    logger.info({ workerId: this.workerId }, 'Worker registered');
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(async () => {
      try {
        const supabase = getSupabase();

        await supabase.rpc('update_worker_heartbeat', {
          p_worker_id: this.workerId,
          p_room_id: this.currentRoomId || null,
        });

        logger.debug({ workerId: this.workerId }, 'Heartbeat sent');
      } catch (error) {
        logger.error({ error }, 'Failed to send heartbeat');
      }
    }, this.config.heartbeatIntervalMs);
  }

  private startCleanupInterval(): void {
    this.cleanupInterval = setInterval(async () => {
      await this.cleanupStaleWorkers();
    }, 60000);
  }

  private async cleanupStaleWorkers(): Promise<void> {
    try {
      const supabase = getSupabase();

      const { data: cleanedCount, error } = await supabase.rpc('cleanup_stale_workers', {
        p_stale_threshold_seconds: 45,
      });

      if (error) {
        logger.error({ error }, 'Failed to cleanup stale workers');
        return;
      }

      if (cleanedCount && cleanedCount > 0) {
        logger.info({ cleanedCount }, 'Cleaned up stale workers');
      }
    } catch (error) {
      logger.error({ error }, 'Error during stale worker cleanup');
    }
  }

  private setupShutdownHandlers(): void {
    const shutdown = async (signal: string) => {
      logger.info({ signal }, 'Shutdown signal received');
      await this.shutdown();
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }

  private async shutdown(): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }

    this.isShuttingDown = true;
    logger.info({ workerId: this.workerId }, 'Starting graceful shutdown');

    this.roomPoller?.stop();

    if (this.currentRoomId) {
      this.callEndDetector?.forceCallEnd();
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    this.aiJobProcessor?.stop();

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    const supabase = getSupabase();
    await supabase
      .from('media_workers')
      .update({
        status: 'stopped',
        current_room_id: null,
      })
      .eq('id', this.workerId);

    logger.info({ workerId: this.workerId }, 'Shutdown complete');
  }

  private async releaseRoom(roomId: string): Promise<void> {
    const supabase = getSupabase();

    await supabase.rpc('release_room_from_worker', {
      p_worker_id: this.workerId,
      p_room_id: roomId,
    });

    logger.info({ roomId, workerId: this.workerId }, 'Released room');
  }

  private async loadSpeechmaticsConfig(): Promise<SpeechmaticsConfig> {
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('speechmatics_config')
      .select('*')
      .limit(1)
      .single();

    if (error || !data) {
      throw new Error('No Speechmatics configuration found');
    }

    return {
      apiKey: data.api_key,
      language: data.default_language || 'en',
      enablePartials: data.enable_partials !== false,
      operatingPoint: data.operating_point || 'standard',
    };
  }

  private async loadLiveKitConfig(serverId: string): Promise<LiveKitServerConfig> {
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('livekit_servers')
      .select('*')
      .eq('id', serverId)
      .single();

    if (error || !data) {
      throw new Error(`LiveKit server config not found: ${serverId}`);
    }

    return {
      server_url: data.server_url,
      api_key: data.api_key,
      api_secret: data.api_secret,
    };
  }
}
