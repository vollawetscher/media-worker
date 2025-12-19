import { createLogger } from '../lib/logger.js';

const logger = createLogger({ component: 'CallEndDetector' });

export class CallEndDetector {
  private roomId: string;
  private emptyTimeoutSeconds: number;
  private currentParticipantCount: number = 0;
  private emptyTimer: NodeJS.Timeout | null = null;
  private onCallEnd?: () => void;

  constructor(roomId: string, emptyTimeoutSeconds: number) {
    this.roomId = roomId;
    this.emptyTimeoutSeconds = emptyTimeoutSeconds;
  }

  setCallEndHandler(handler: () => void): void {
    this.onCallEnd = handler;
  }

  updateParticipantCount(count: number): void {
    logger.debug({ roomId: this.roomId, count }, 'Participant count updated');

    this.currentParticipantCount = count;

    if (count === 0) {
      this.startEmptyTimer();
    } else {
      this.cancelEmptyTimer();
    }
  }

  private startEmptyTimer(): void {
    if (this.emptyTimer) {
      return;
    }

    logger.info(
      {
        roomId: this.roomId,
        timeoutSeconds: this.emptyTimeoutSeconds,
      },
      'Room is empty, starting empty timeout timer'
    );

    this.emptyTimer = setTimeout(() => {
      logger.info({ roomId: this.roomId }, 'Empty timeout reached, triggering call end');
      this.onCallEnd?.();
    }, this.emptyTimeoutSeconds * 1000);
  }

  private cancelEmptyTimer(): void {
    if (this.emptyTimer) {
      logger.debug({ roomId: this.roomId }, 'Cancelling empty timer, participants rejoined');
      clearTimeout(this.emptyTimer);
      this.emptyTimer = null;
    }
  }

  forceCallEnd(): void {
    logger.info({ roomId: this.roomId }, 'Forcing call end');
    this.cancelEmptyTimer();
    this.onCallEnd?.();
  }

  cleanup(): void {
    this.cancelEmptyTimer();
  }
}
