import { RealtimeChannel } from '@supabase/supabase-js';
import { getSupabase } from '../lib/supabase.js';
import { createLogger } from '../lib/logger.js';

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

type RoomCallback = (room: Room) => void;

export class RoomSubscriber {
  private workerId: string;
  private channel: RealtimeChannel | null = null;
  private onRoomClaimed: RoomCallback | null = null;
  private isActive: boolean = false;

  constructor(workerId: string) {
    this.workerId = workerId;
  }

  async start(onRoomClaimed: RoomCallback): Promise<void> {
    this.onRoomClaimed = onRoomClaimed;
    this.isActive = true;

    const supabase = getSupabase();

    logger.info({ workerId: this.workerId }, 'Starting room subscription');

    this.channel = supabase
      .channel('room-notifications')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'rooms',
          filter: 'status=in.(pending,active)',
        },
        async (payload) => {
          if (!this.isActive) return;

          const room = payload.new as any;
          logger.info({ roomId: room.id, roomName: room.room_name }, 'New room detected, attempting to claim');

          const claimed = await this.claimRoom(room.id);

          if (claimed && this.onRoomClaimed) {
            logger.info({ roomId: room.id, roomName: room.room_name }, 'Successfully claimed room');
            this.onRoomClaimed({
              id: room.id,
              room_name: room.room_name,
              server_id: room.server_id,
              status: room.status,
              ai_enabled: room.ai_enabled,
              empty_timeout: room.empty_timeout,
              transcription_enabled: room.transcription_enabled,
            });
          } else {
            logger.debug({ roomId: room.id }, 'Failed to claim room (another worker claimed it)');
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'rooms',
          filter: 'status=eq.active',
        },
        async (payload) => {
          if (!this.isActive) return;

          const room = payload.new as any;
          const oldRoom = payload.old as any;

          if (oldRoom.status !== 'active' && room.status === 'active') {
            if (!room.media_worker_id || room.media_worker_id === this.workerId) {
              logger.info({ roomId: room.id, roomName: room.room_name }, 'Room became active, attempting to claim');

              const claimed = await this.claimRoom(room.id);

              if (claimed && this.onRoomClaimed) {
                logger.info({ roomId: room.id, roomName: room.room_name }, 'Successfully claimed newly active room');
                this.onRoomClaimed({
                  id: room.id,
                  room_name: room.room_name,
                  server_id: room.server_id,
                  status: room.status,
                  ai_enabled: room.ai_enabled,
                  empty_timeout: room.empty_timeout,
                  transcription_enabled: room.transcription_enabled,
                });
              }
            }
          }
        }
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          logger.info({ workerId: this.workerId }, 'Successfully subscribed to room notifications');
        } else if (status === 'CLOSED') {
          logger.warn({ workerId: this.workerId }, 'Room subscription closed');
        } else if (status === 'CHANNEL_ERROR') {
          logger.error({ workerId: this.workerId }, 'Room subscription error');
        }
      });

    logger.info({ workerId: this.workerId }, 'Checking for existing unclaimed rooms on startup');
    await this.checkExistingRooms();
  }

  async stop(): Promise<void> {
    logger.info({ workerId: this.workerId }, 'Stopping room subscription');
    this.isActive = false;

    if (this.channel) {
      await this.channel.unsubscribe();
      this.channel = null;
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
      logger.debug('No existing unclaimed rooms found');
      return;
    }

    const room = rooms[0];
    logger.info({ roomId: room.id, roomName: room.room_name }, 'Found existing unclaimed room on startup');

    const claimed = await this.claimRoom(room.id);

    if (claimed && this.onRoomClaimed) {
      logger.info({ roomId: room.id, roomName: room.room_name }, 'Successfully claimed existing room');
      this.onRoomClaimed({
        id: room.id,
        room_name: room.room_name,
        server_id: room.server_id,
        status: room.status,
        ai_enabled: room.ai_enabled,
        empty_timeout: room.empty_timeout,
        transcription_enabled: room.transcription_enabled,
      });
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
