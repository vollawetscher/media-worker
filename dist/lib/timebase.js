import { getSupabase } from './supabase.js';
import { createLogger } from './logger.js';
const logger = createLogger({ component: 'Timebase' });
export class Timebase {
    t0 = null;
    roomId;
    constructor(roomId) {
        this.roomId = roomId;
    }
    async initialize() {
        const supabase = getSupabase();
        const { data: room, error } = await supabase
            .from('rooms')
            .select('timebase_started_at')
            .eq('id', this.roomId)
            .maybeSingle();
        if (error) {
            throw new Error(`Failed to load room timebase: ${error.message}`);
        }
        if (!room) {
            throw new Error(`Room ${this.roomId} not found`);
        }
        if (room.timebase_started_at) {
            this.t0 = new Date(room.timebase_started_at);
            logger.info({ roomId: this.roomId, t0: this.t0 }, 'Loaded existing timebase from database');
        }
        else {
            this.t0 = new Date();
            const { error: updateError } = await supabase
                .from('rooms')
                .update({ timebase_started_at: this.t0.toISOString() })
                .eq('id', this.roomId);
            if (updateError) {
                throw new Error(`Failed to set timebase in database: ${updateError.message}`);
            }
            logger.info({ roomId: this.roomId, t0: this.t0 }, 'Established new timebase and stored in database');
        }
    }
    getRelativeTime(wallClockTime) {
        if (!this.t0) {
            throw new Error('Timebase not initialized. Call initialize() first.');
        }
        const now = wallClockTime || new Date();
        const relativeTimeMs = now.getTime() - this.t0.getTime();
        return relativeTimeMs / 1000;
    }
    getT0() {
        if (!this.t0) {
            throw new Error('Timebase not initialized. Call initialize() first.');
        }
        return this.t0;
    }
    isInitialized() {
        return this.t0 !== null;
    }
    convertTimestamp(timestamp) {
        if (!this.t0) {
            throw new Error('Timebase not initialized. Call initialize() first.');
        }
        const time = typeof timestamp === 'number' ? new Date(timestamp) : timestamp;
        return this.getRelativeTime(time);
    }
}
//# sourceMappingURL=timebase.js.map