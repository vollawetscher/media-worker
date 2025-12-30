import { createLogger } from '../lib/logger.js';
const logger = createLogger({ component: 'CallEndDetector' });
export class CallEndDetector {
    roomId;
    emptyTimeoutSeconds;
    currentParticipantCount = 0;
    emptyTimer = null;
    onCallEnd;
    constructor(roomId, emptyTimeoutSeconds) {
        this.roomId = roomId;
        this.emptyTimeoutSeconds = emptyTimeoutSeconds;
    }
    setCallEndHandler(handler) {
        this.onCallEnd = handler;
    }
    updateParticipantCount(count) {
        logger.debug({ roomId: this.roomId, count }, 'Participant count updated');
        this.currentParticipantCount = count;
        if (count === 0) {
            this.startEmptyTimer();
        }
        else {
            this.cancelEmptyTimer();
        }
    }
    startEmptyTimer() {
        if (this.emptyTimer) {
            return;
        }
        logger.info({
            roomId: this.roomId,
            timeoutSeconds: this.emptyTimeoutSeconds,
        }, 'Room is empty, starting empty timeout timer');
        this.emptyTimer = setTimeout(() => {
            logger.info({ roomId: this.roomId }, 'Empty timeout reached, triggering call end');
            this.onCallEnd?.();
        }, this.emptyTimeoutSeconds * 1000);
    }
    cancelEmptyTimer() {
        if (this.emptyTimer) {
            logger.debug({ roomId: this.roomId }, 'Cancelling empty timer, participants rejoined');
            clearTimeout(this.emptyTimer);
            this.emptyTimer = null;
        }
    }
    forceCallEnd() {
        logger.info({ roomId: this.roomId }, 'Forcing call end');
        this.cancelEmptyTimer();
        this.onCallEnd?.();
    }
    cleanup() {
        this.cancelEmptyTimer();
    }
}
//# sourceMappingURL=call-end-detector.js.map