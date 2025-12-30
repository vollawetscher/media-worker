import { getSupabase } from '../lib/supabase.js';
import { createLogger } from '../lib/logger.js';
const logger = createLogger({ component: 'RoomPoller' });
export class RoomPoller {
    workerId;
    pollingIntervalMs;
    pollingTimer = null;
    isPolling = false;
    constructor(workerId, pollingIntervalMs) {
        this.workerId = workerId;
        this.pollingIntervalMs = pollingIntervalMs;
    }
    async start() {
        logger.info({ workerId: this.workerId }, 'Starting room polling');
        this.isPolling = true;
        return new Promise((resolve, reject) => {
            const poll = async () => {
                if (!this.isPolling) {
                    reject(new Error('Polling stopped'));
                    return;
                }
                try {
                    const room = await this.pollForRoom();
                    if (room) {
                        this.stop();
                        resolve(room);
                    }
                    else {
                        this.pollingTimer = setTimeout(poll, this.pollingIntervalMs);
                    }
                }
                catch (error) {
                    logger.error({ error, workerId: this.workerId }, 'Error polling for rooms');
                    this.pollingTimer = setTimeout(poll, this.pollingIntervalMs);
                }
            };
            poll();
        });
    }
    stop() {
        logger.info({ workerId: this.workerId }, 'Stopping room polling');
        this.isPolling = false;
        if (this.pollingTimer) {
            clearTimeout(this.pollingTimer);
            this.pollingTimer = null;
        }
    }
    async pollForRoom() {
        const supabase = getSupabase();
        const { data: rooms, error } = await supabase
            .from('rooms')
            .select('id, room_name, server_id, status, ai_enabled, empty_timeout, transcription_enabled, media_worker_id, media_worker_heartbeat')
            .or('media_worker_id.is.null,media_worker_heartbeat.lt.' + new Date(Date.now() - 45000).toISOString())
            .in('status', ['pending', 'active'])
            .order('created_at', { ascending: true })
            .limit(1);
        if (error) {
            logger.error({ error }, 'Failed to query for available rooms');
            return null;
        }
        if (!rooms || rooms.length === 0) {
            logger.debug('No available rooms found');
            return null;
        }
        const room = rooms[0];
        logger.info({ roomId: room.id, roomName: room.room_name }, 'Found available room, attempting to claim');
        const claimed = await this.claimRoom(room.id);
        if (claimed) {
            logger.info({ roomId: room.id, roomName: room.room_name }, 'Successfully claimed room');
            return room;
        }
        logger.debug({ roomId: room.id }, 'Failed to claim room (another worker claimed it)');
        return null;
    }
    async claimRoom(roomId) {
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
//# sourceMappingURL=room-poller.js.map