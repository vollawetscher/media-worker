import { RealtimeChannel } from '@supabase/supabase-js';
import { getSupabase } from '../lib/supabase.js';
import { createLogger } from '../lib/logger.js';
import type { WorkerConfig } from '../config/index.js';
import pg from 'pg';

const logger = createLogger({ component: 'RoomSubscriber' });

export interface Room {
  id: string;
  room_name: string;
  server_id: string;
  status: string;
  ai_enabled: boolean;
  empty_timeout: number;
  transcription_enabled: boolean;
}

export interface DiscoveryStats {
  realtimeCount: number;
  notifyCount: number;
  startupCount: number;
  lastRealtimeNotification: Date | null;
  lastDatabaseNotification: Date | null;
  realtimeHealthy: boolean;
}

type RoomCallback = (room: Room, discoveryMethod: 'realtime' | 'notify' | 'startup') => void;

export class RoomSubscriber {
  private workerId: string;
  private config: WorkerConfig;
  private channel: RealtimeChannel | null = null;
  private pgClient: pg.Client | null = null;
  private onRoomClaimed: RoomCallback | null = null;
  private isActive: boolean = false;
  private reconnectionTimer: NodeJS.Timeout | null = null;
  private healthCheckTimer: NodeJS.Timeout | null = null;

  private stats: DiscoveryStats = {
    realtimeCount: 0,
    notifyCount: 0,
    startupCount: 0,
    lastRealtimeNotification: null,
    lastDatabaseNotification: null,
    realtimeHealthy: false,
  };

  constructor(workerId: string, config: WorkerConfig) {
    this.workerId = workerId;
    this.config = config;
  }

  private shouldClaimRoom(room: { transcription_enabled: boolean }): boolean {
    const mode = this.config.mode;

    if (mode === 'both') {
      return true;
    }

    if (mode === 'transcription') {
      return room.transcription_enabled === true;
    }

    if (mode === 'ai-jobs') {
      return room.transcription_enabled === false;
    }

    return false;
  }

  getStats(): DiscoveryStats {
    return { ...this.stats };
  }

  async start(onRoomClaimed: RoomCallback): Promise<void> {
    this.onRoomClaimed = onRoomClaimed;
    this.isActive = true;

    logger.info({ workerId: this.workerId }, 'Starting room subscription with hybrid discovery');

    await this.startRealtimeSubscription();

    if (this.config.enableDatabaseNotify) {
      await this.startDatabaseNotifications();
    }

    this.startHealthCheck();

    logger.info({ workerId: this.workerId }, 'Checking for existing unclaimed rooms on startup');
    await this.checkExistingRooms();
  }

  private async startRealtimeSubscription(): Promise<void> {
    const supabase = getSupabase();

    logger.info({ workerId: this.workerId }, 'Starting Supabase Realtime subscription');

    this.channel = supabase
      .channel('room-notifications')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'rooms',
        },
        async (payload) => {
          this.stats.lastRealtimeNotification = new Date();
          this.stats.realtimeHealthy = true;

          logger.info({ workerId: this.workerId, payload: payload.new }, '[REALTIME] Received INSERT event');

          if (!this.isActive) {
            logger.warn({ workerId: this.workerId }, '[REALTIME] Worker inactive, ignoring event');
            return;
          }

          const room = payload.new as any;

          if (room.status !== 'pending' && room.status !== 'active') {
            logger.debug({ roomId: room.id, status: room.status }, 'Skipping room with non-claimable status');
            return;
          }

          if (!this.shouldClaimRoom(room)) {
            logger.debug({ roomId: room.id, mode: this.config.mode, transcriptionEnabled: room.transcription_enabled }, '[REALTIME] Skipping room (mode mismatch)');
            return;
          }

          logger.info({ roomId: room.id, roomName: room.room_name, status: room.status }, '[REALTIME] New room detected, attempting to claim');

          const claimed = await this.claimRoom(room.id);

          if (claimed && this.onRoomClaimed) {
            this.stats.realtimeCount++;
            logger.info({ roomId: room.id, roomName: room.room_name, stats: this.stats }, '[REALTIME] Successfully claimed room');
            this.onRoomClaimed({
              id: room.id,
              room_name: room.room_name,
              server_id: room.server_id,
              status: room.status,
              ai_enabled: room.ai_enabled,
              empty_timeout: room.empty_timeout,
              transcription_enabled: room.transcription_enabled,
            }, 'realtime');
          } else {
            logger.debug({ roomId: room.id }, '[REALTIME] Failed to claim room (another worker claimed it)');
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'rooms',
          filter: `media_worker_id=eq.${this.workerId}`,
        },
        async (payload) => {
          this.stats.lastRealtimeNotification = new Date();
          this.stats.realtimeHealthy = true;

          logger.info({ workerId: this.workerId, old: payload.old, new: payload.new }, '[REALTIME] Received UPDATE event');

          if (!this.isActive) {
            logger.warn({ workerId: this.workerId }, '[REALTIME] Worker inactive, ignoring UPDATE event');
            return;
          }

          const room = payload.new as any;
          const oldRoom = payload.old as any;

          if (oldRoom.status !== 'active' && room.status === 'active') {
            if (!room.media_worker_id || room.media_worker_id === this.workerId) {
              if (!this.shouldClaimRoom(room)) {
                logger.debug({ roomId: room.id, mode: this.config.mode, transcriptionEnabled: room.transcription_enabled }, '[REALTIME] Skipping room (mode mismatch)');
                return;
              }

              logger.info({ roomId: room.id, roomName: room.room_name }, '[REALTIME] Room became active, attempting to claim');

              const claimed = await this.claimRoom(room.id);

              if (claimed && this.onRoomClaimed) {
                this.stats.realtimeCount++;
                logger.info({ roomId: room.id, roomName: room.room_name, stats: this.stats }, '[REALTIME] Successfully claimed newly active room');
                this.onRoomClaimed({
                  id: room.id,
                  room_name: room.room_name,
                  server_id: room.server_id,
                  status: room.status,
                  ai_enabled: room.ai_enabled,
                  empty_timeout: room.empty_timeout,
                  transcription_enabled: room.transcription_enabled,
                }, 'realtime');
              }
            }
          }
        }
      )
      .subscribe((status, err) => {
        logger.info({ workerId: this.workerId, status, error: err }, 'Realtime subscription status changed');

        if (status === 'SUBSCRIBED') {
          this.stats.realtimeHealthy = true;
          logger.info({ workerId: this.workerId }, '✓ Successfully subscribed to Realtime notifications');
        } else if (status === 'CLOSED') {
          this.stats.realtimeHealthy = false;
          logger.warn({ workerId: this.workerId }, '✗ Realtime subscription closed, will attempt reconnection');
          this.scheduleReconnection();
        } else if (status === 'CHANNEL_ERROR') {
          this.stats.realtimeHealthy = false;
          logger.error({ workerId: this.workerId, error: err }, '✗ Realtime subscription error');
          this.scheduleReconnection();
        } else if (status === 'TIMED_OUT') {
          this.stats.realtimeHealthy = false;
          logger.error({ workerId: this.workerId }, '✗ Realtime subscription timed out');
          this.scheduleReconnection();
        }
      });
  }

  private async startDatabaseNotifications(): Promise<void> {
    if (!this.config.supabase.databaseUrl) {
      logger.info({ workerId: this.workerId }, 'Database URL not configured, skipping LISTEN/NOTIFY setup');
      return;
    }

    try {
      logger.info({ workerId: this.workerId }, 'Starting database LISTEN for pg_notify');

      this.pgClient = new pg.Client({
        connectionString: this.config.supabase.databaseUrl,
        ssl: { rejectUnauthorized: false },
      });

      await this.pgClient.connect();

      this.pgClient.on('notification', async (msg) => {
        if (msg.channel === 'room_available' && msg.payload) {
          this.stats.lastDatabaseNotification = new Date();

          try {
            const payload = JSON.parse(msg.payload);
            logger.info({ workerId: this.workerId, payload }, '[NOTIFY] Received database notification');

            if (!this.isActive) {
              logger.warn({ workerId: this.workerId }, '[NOTIFY] Worker inactive, ignoring notification');
              return;
            }

            const roomId = payload.room_id;
            const status = payload.status;
            const transcriptionEnabled = payload.transcription_enabled;

            if (status !== 'pending' && status !== 'active') {
              logger.debug({ roomId, status }, '[NOTIFY] Skipping room with non-claimable status');
              return;
            }

            if (!this.shouldClaimRoom({ transcription_enabled: transcriptionEnabled })) {
              logger.debug({ roomId, mode: this.config.mode, transcriptionEnabled }, '[NOTIFY] Skipping room (mode mismatch)');
              return;
            }

            logger.info({ roomId, status }, '[NOTIFY] Room available, attempting to claim');

            const claimed = await this.claimRoom(roomId);

            if (claimed && this.onRoomClaimed) {
              this.stats.notifyCount++;

              const { data: room, error } = await getSupabase()
                .from('rooms')
                .select('*')
                .eq('id', roomId)
                .single();

              if (!error && room) {
                logger.info({ roomId, roomName: room.room_name, stats: this.stats }, '[NOTIFY] Successfully claimed room');
                this.onRoomClaimed({
                  id: room.id,
                  room_name: room.room_name,
                  server_id: room.server_id,
                  status: room.status,
                  ai_enabled: room.ai_enabled,
                  empty_timeout: room.empty_timeout,
                  transcription_enabled: room.transcription_enabled,
                }, 'notify');
              }
            } else {
              logger.debug({ roomId }, '[NOTIFY] Failed to claim room (another worker claimed it)');
            }
          } catch (err) {
            logger.error({ error: err }, '[NOTIFY] Failed to parse notification payload');
          }
        }
      });

      await this.pgClient.query('LISTEN room_available');
      logger.info({ workerId: this.workerId }, '✓ Successfully listening for database notifications');

    } catch (err) {
      logger.error({ error: err }, '✗ Failed to setup database LISTEN, continuing without it');
      this.pgClient = null;
    }
  }

  private startHealthCheck(): void {
    this.healthCheckTimer = setInterval(() => {
      const timeSinceLastRealtime = this.stats.lastRealtimeNotification
        ? Date.now() - this.stats.lastRealtimeNotification.getTime()
        : null;

      // Only warn if we haven't received notifications in 5 minutes AND the channel reports unhealthy
      // Quiet periods are normal and don't indicate problems
      if (timeSinceLastRealtime && timeSinceLastRealtime > 300000 && !this.stats.realtimeHealthy) {
        logger.warn(
          { timeSinceLastRealtime, workerId: this.workerId },
          'Realtime connection may be unhealthy - no notifications for 5+ minutes'
        );
      }

      logger.debug({
        workerId: this.workerId,
        stats: this.stats,
        timeSinceLastRealtime
      }, 'Health check');

    }, 30000);
  }

  private scheduleReconnection(): void {
    if (this.reconnectionTimer) {
      return;
    }

    logger.info(
      { workerId: this.workerId, retryInterval: this.config.realtimeRetryIntervalMs },
      'Scheduling Realtime reconnection attempt'
    );

    this.reconnectionTimer = setTimeout(async () => {
      this.reconnectionTimer = null;

      if (!this.isActive) {
        return;
      }

      logger.info({ workerId: this.workerId }, 'Attempting to reconnect Realtime subscription');

      if (this.channel) {
        await this.channel.unsubscribe();
        this.channel = null;
      }

      await this.startRealtimeSubscription();
    }, this.config.realtimeRetryIntervalMs);
  }

  async stop(): Promise<void> {
    logger.info({ workerId: this.workerId, finalStats: this.stats }, 'Stopping room subscription');
    this.isActive = false;

    if (this.reconnectionTimer) {
      clearTimeout(this.reconnectionTimer);
      this.reconnectionTimer = null;
    }

    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    if (this.channel) {
      await this.channel.unsubscribe();
      this.channel = null;
    }

    if (this.pgClient) {
      try {
        await this.pgClient.query('UNLISTEN room_available');
        await this.pgClient.end();
      } catch (err) {
        logger.error({ error: err }, 'Error closing database notification client');
      }
      this.pgClient = null;
    }

    this.onRoomClaimed = null;
  }

  private async checkExistingRooms(): Promise<void> {
    const supabase = getSupabase();

    const { data: rooms, error } = await supabase
      .from('rooms')
      .select('id, room_name, server_id, status, ai_enabled, empty_timeout, transcription_enabled, media_worker_id, media_worker_heartbeat')
      .or('media_worker_id.is.null,media_worker_heartbeat.lt.' + new Date(Date.now() - 45000).toISOString())
      .in('status', ['pending', 'active'])
      .order('created_at', { ascending: true })
      .limit(1);

    if (error) {
      logger.error({ error }, 'Failed to query for existing rooms');
      return;
    }

    if (!rooms || rooms.length === 0) {
      logger.debug('No existing unclaimed rooms found on startup');
      return;
    }

    const room = rooms[0];

    if (!this.shouldClaimRoom(room)) {
      logger.debug({ roomId: room.id, mode: this.config.mode, transcriptionEnabled: room.transcription_enabled }, '[STARTUP] Skipping room (mode mismatch)');
      return;
    }

    logger.info({ roomId: room.id, roomName: room.room_name }, '[STARTUP] Found existing unclaimed room');

    const claimed = await this.claimRoom(room.id);

    if (claimed && this.onRoomClaimed) {
      this.stats.startupCount++;
      logger.info({ roomId: room.id, roomName: room.room_name, stats: this.stats }, '[STARTUP] Successfully claimed existing room');
      this.onRoomClaimed({
        id: room.id,
        room_name: room.room_name,
        server_id: room.server_id,
        status: room.status,
        ai_enabled: room.ai_enabled,
        empty_timeout: room.empty_timeout,
        transcription_enabled: room.transcription_enabled,
      }, 'startup');
    }
  }

  private async claimRoom(roomId: string): Promise<boolean> {
    const supabase = getSupabase();

    const { data, error } = await supabase.rpc('claim_room_for_worker', {
      p_worker_id: this.workerId,
      p_room_id: roomId,
    });

    if (error) {
      logger.error({ error, roomId }, 'Error calling claim_room_for_worker RPC');
      return false;
    }

    return data === true;
  }
}
