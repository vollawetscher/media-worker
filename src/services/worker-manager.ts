import { getSupabase } from '../lib/supabase.js';
import { createLogger } from '../lib/logger.js';
import { Timebase } from '../lib/timebase.js';
import { RoomSubscriber, Room } from './room-subscriber.js';
import { RoomPoller } from './room-poller.js';
import { TranscriptManager } from './transcript-manager.js';
import { AudioStreamManager } from './audio-stream-manager.js';
import { LiveKitRoomClient, LiveKitServerConfig } from './livekit-room.js';
import { SpeechmaticsConfig } from './speechmatics.js';
import { CallEndDetector } from './call-end-detector.js';
import { AIJobProcessor } from './ai-job-processor.js';
import { PostCallJobScheduler } from './post-call-job-scheduler.js';
import type { WorkerConfig } from '../config/index.js';

const logger = createLogger({ component: 'WorkerManager' });

interface RoomClaimAttempt {
  roomId: string;
  timestamp: Date;
  success: boolean;
  discoveryMethod: 'realtime' | 'notify' | 'startup' | 'polling';
}

interface DiscoveryMetrics {
  realtimeCount: number;
  notifyCount: number;
  startupCount: number;
  pollingCount: number;
  totalClaims: number;
}

export class WorkerManager {
  private config: WorkerConfig;
  private workerId: string;
  private currentRoomId: string | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private statsInterval: NodeJS.Timeout | null = null;
  private isShuttingDown: boolean = false;
  private isProcessingRoom: boolean = false;

  private roomSubscriber?: RoomSubscriber;
  private roomPoller?: RoomPoller;
  private livekitClient?: LiveKitRoomClient;
  private audioStreamManager?: AudioStreamManager;
  private transcriptManager?: TranscriptManager;
  private callEndDetector?: CallEndDetector;
  private aiJobProcessor?: AIJobProcessor;
  private timebase?: Timebase;

  private recentClaimAttempts: RoomClaimAttempt[] = [];
  private metrics: DiscoveryMetrics = {
    realtimeCount: 0,
    notifyCount: 0,
    startupCount: 0,
    pollingCount: 0,
    totalClaims: 0,
  };

  constructor(config: WorkerConfig) {
    this.config = config;
    this.workerId = config.workerId;
  }

  async start(): Promise<void> {
    logger.info({ workerId: this.workerId, mode: this.config.mode, config: this.config }, 'Starting worker');

    await this.cleanupStaleWorkers();
    await this.registerWorker();
    this.startHeartbeat();
    this.startCleanupInterval();
    this.startStatsReporting();
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
    logger.info('Starting hybrid room discovery (Realtime + NOTIFY + Polling)');

    const roomHandler = async (room: Room, discoveryMethod: 'realtime' | 'notify' | 'startup' | 'polling') => {
      if (this.isShuttingDown || this.isProcessingRoom) {
        logger.warn({ roomId: room.id, discoveryMethod }, 'Ignoring room notification (shutting down or already processing)');
        return;
      }

      if (this.wasRecentlyAttempted(room.id)) {
        logger.debug({ roomId: room.id, discoveryMethod }, 'Skipping room (recently attempted by another discovery method)');
        return;
      }

      this.recordClaimAttempt(room.id, true, discoveryMethod);
      this.isProcessingRoom = true;

      this.metrics[`${discoveryMethod}Count`]++;
      this.metrics.totalClaims++;

      try {
        logger.info(
          {
            roomId: room.id,
            roomName: room.room_name,
            discoveryMethod,
            metrics: this.metrics
          },
          `[${discoveryMethod.toUpperCase()}] Starting room processing`
        );

        await this.processRoom(room);

        logger.info({ roomId: room.id, discoveryMethod }, 'Room processing completed successfully');
      } catch (error) {
        logger.error({ error, roomId: room.id, discoveryMethod }, 'Error processing room');

        if (this.currentRoomId) {
          await this.releaseRoom(this.currentRoomId).catch(err =>
            logger.error({ err }, 'Failed to release room during error recovery')
          );
        }
      } finally {
        const completedRoomId = room.id;
        this.currentRoomId = null;
        this.isProcessingRoom = false;

        this.clearRoomFromCache(completedRoomId);
        this.cleanupOldClaimAttempts();

        logger.info({ workerId: this.workerId }, 'Worker now available, checking for next room immediately');

        if (this.roomPoller && !this.isShuttingDown) {
          await this.roomPoller.checkNow().catch(err =>
            logger.error({ err }, 'Error during immediate room check')
          );
        }
      }
    };

    this.roomSubscriber = new RoomSubscriber(this.workerId, this.config);
    await this.roomSubscriber.start(roomHandler);

    if (this.config.enablePollingFallback) {
      logger.info({ pollingInterval: this.config.pollingIntervalMs }, 'Starting polling fallback');
      this.roomPoller = new RoomPoller(this.workerId, this.config.pollingIntervalMs);
      await this.roomPoller.start(roomHandler);
    } else {
      logger.info('Polling fallback disabled by configuration');
    }

    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        if (this.isShuttingDown) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 1000);

      // Ensure interval is cleared even if Promise is abandoned
      // Store it so shutdown can clean it up
      if (this.cleanupInterval) {
        clearInterval(this.cleanupInterval);
      }
      this.cleanupInterval = checkInterval as any;
    });
  }

  private wasRecentlyAttempted(roomId: string): boolean {
    const cacheDuration = this.config.roomClaimCacheDurationMs;
    const now = Date.now();

    return this.recentClaimAttempts.some(
      attempt =>
        attempt.roomId === roomId &&
        (now - attempt.timestamp.getTime()) < cacheDuration
    );
  }

  private recordClaimAttempt(roomId: string, success: boolean, discoveryMethod: 'realtime' | 'notify' | 'startup' | 'polling'): void {
    this.recentClaimAttempts.push({
      roomId,
      timestamp: new Date(),
      success,
      discoveryMethod,
    });

    if (this.recentClaimAttempts.length > 50) {
      this.recentClaimAttempts = this.recentClaimAttempts.slice(-50);
    }
  }

  private cleanupOldClaimAttempts(): void {
    const cacheDuration = this.config.roomClaimCacheDurationMs;
    const now = Date.now();

    this.recentClaimAttempts = this.recentClaimAttempts.filter(
      attempt => (now - attempt.timestamp.getTime()) < cacheDuration
    );
  }

  private clearRoomFromCache(roomId: string): void {
    this.recentClaimAttempts = this.recentClaimAttempts.filter(
      attempt => attempt.roomId !== roomId
    );
    logger.debug({ roomId }, 'Cleared room from claim cache');
  }

  private startStatsReporting(): void {
    this.statsInterval = setInterval(() => {
      const subscriberStats = this.roomSubscriber?.getStats();

      logger.info({
        workerId: this.workerId,
        claimMetrics: this.metrics,
        subscriberStats,
        recentAttempts: this.recentClaimAttempts.length,
      }, 'Discovery statistics');
    }, 60000);
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

    return new Promise((resolve, reject) => {
      let checkInterval: NodeJS.Timeout | null = null;

      checkInterval = setInterval(() => {
        if (this.isShuttingDown || !this.livekitClient?.isConnected()) {
          if (checkInterval) {
            clearInterval(checkInterval);
            checkInterval = null;
          }
          resolve();
        }
      }, 1000);

      // Ensure interval cleanup on errors or shutdown
      const cleanup = () => {
        if (checkInterval) {
          clearInterval(checkInterval);
          checkInterval = null;
        }
      };

      // Clean up if worker is shut down externally
      process.once('SIGTERM', cleanup);
      process.once('SIGINT', cleanup);
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

      logger.info({ roomId: this.currentRoomId }, 'Checking for existing post-call jobs');
      const { data: existingJobs } = await supabase
        .from('post_call_jobs')
        .select('id')
        .eq('room_id', this.currentRoomId!)
        .limit(1);

      if (!existingJobs || existingJobs.length === 0) {
        logger.info({ roomId: this.currentRoomId }, 'Creating post-call jobs from worker');
        try {
          const jobScheduler = new PostCallJobScheduler(this.currentRoomId!);
          await jobScheduler.scheduleJobs();
          logger.info({ roomId: this.currentRoomId }, 'Post-call jobs created by worker');
        } catch (jobError) {
          logger.error({ error: jobError, roomId: this.currentRoomId }, 'Failed to create post-call jobs, webhook will handle it');
        }
      } else {
        logger.info({ roomId: this.currentRoomId }, 'Post-call jobs already exist, skipping creation');
      }

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
    logger.info({ workerId: this.workerId, finalMetrics: this.metrics }, 'Starting graceful shutdown');

    await this.roomSubscriber?.stop();
    await this.roomPoller?.stop();

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

    if (this.statsInterval) {
      clearInterval(this.statsInterval);
    }

    const supabase = getSupabase();
    await supabase
      .from('media_workers')
      .update({
        status: 'stopped',
        current_room_id: null,
      })
      .eq('id', this.workerId);

    logger.info({ workerId: this.workerId, finalMetrics: this.metrics }, 'Shutdown complete');
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
