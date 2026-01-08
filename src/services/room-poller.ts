import { getSupabase } from '../lib/supabase.js';
import { createLogger } from '../lib/logger.js';
import type { WorkerConfig } from '../config/index.js';

const logger = createLogger({ component: 'RoomPoller' });

export interface Room {
  id: string;
  room_name: string;
  server_id: string;
  status: string;
  ai_enabled: boolean;
  empty_timeout: number;
  transcription_enabled: boolean;
}

type RoomCallback = (room: Room, discoveryMethod: 'polling') => void;

export class RoomPoller {
  private workerId: string;
  private config: WorkerConfig;
  private pollingIntervalMs: number;
  private pollingTimer: NodeJS.Timeout | null = null;
  private isPolling: boolean = false;
  private onRoomFound: RoomCallback | null = null;

  constructor(workerId: string, config: WorkerConfig) {
    this.workerId = workerId;
    this.config = config;
    this.pollingIntervalMs = config.pollingIntervalMs;
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

  async start(onRoomFound: RoomCallback): Promise<void> {
    logger.info({ workerId: this.workerId, pollingInterval: this.pollingIntervalMs }, '[POLLING] Starting continuous room polling');
    this.isPolling = true;
    this.onRoomFound = onRoomFound;

    const poll = async () => {
      if (!this.isPolling) {
        return;
      }

      try {
        logger.debug({ workerId: this.workerId }, '[POLLING] Polling cycle started');
        const room = await this.pollForRoom();
        if (room && this.onRoomFound) {
          logger.info({ roomId: room.id, roomName: room.room_name }, '[POLLING] Found room, invoking callback');
          this.onRoomFound(room, 'polling');
        } else {
          logger.debug({ workerId: this.workerId }, '[POLLING] Polling cycle complete - no rooms available');
        }
      } catch (error) {
        logger.error({ error, workerId: this.workerId }, '[POLLING] Error polling for rooms');
      }

      if (this.isPolling) {
        this.pollingTimer = setTimeout(poll, this.pollingIntervalMs);
      }
    };

    poll();
  }

  async stop(): Promise<void> {
    logger.info({ workerId: this.workerId }, '[POLLING] Stopping room polling');
    this.isPolling = false;
    this.onRoomFound = null;

    if (this.pollingTimer) {
      clearTimeout(this.pollingTimer);
      this.pollingTimer = null;
    }
  }

  async checkNow(): Promise<void> {
    if (!this.isPolling || !this.onRoomFound) {
      return;
    }

    logger.info({ workerId: this.workerId }, '[POLLING] Immediate check triggered');

    try {
      const room = await this.pollForRoom();
      if (room && this.onRoomFound) {
        logger.info({ roomId: room.id, roomName: room.room_name }, '[POLLING] Immediate check found room');
        this.onRoomFound(room, 'polling');
      } else {
        logger.debug({ workerId: this.workerId }, '[POLLING] Immediate check - no rooms available');
      }
    } catch (error) {
      logger.error({ error, workerId: this.workerId }, '[POLLING] Error during immediate check');
    }
  }

  private async pollForRoom(): Promise<Room | null> {
    const supabase = getSupabase();

    const { data: rooms, error } = await supabase
      .from('rooms')
      .select('id, room_name, server_id, status, ai_enabled, empty_timeout, transcription_enabled, media_worker_id, media_worker_heartbeat')
      .or('media_worker_id.is.null,media_worker_heartbeat.lt.' + new Date(Date.now() - 45000).toISOString())
      .in('status', ['pending', 'active'])
      .order('created_at', { ascending: true })
      .limit(1);

    if (error) {
      logger.error({ error }, '[POLLING] Failed to query for available rooms');
      return null;
    }

    if (!rooms || rooms.length === 0) {
      logger.debug('[POLLING] No available rooms found');
      return null;
    }

    const room = rooms[0];

    if (!this.shouldClaimRoom(room)) {
      logger.debug({ roomId: room.id, mode: this.config.mode, transcriptionEnabled: room.transcription_enabled }, '[POLLING] Skipping room (mode mismatch)');
      return null;
    }

    logger.info({ roomId: room.id, roomName: room.room_name }, '[POLLING] Found available room, attempting to claim');

    const claimed = await this.claimRoom(room.id);

    if (claimed) {
      logger.info({ roomId: room.id, roomName: room.room_name }, '[POLLING] Successfully claimed room');
      return room as Room;
    }

    logger.debug({ roomId: room.id }, '[POLLING] Failed to claim room (another worker claimed it)');
    return null;
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
