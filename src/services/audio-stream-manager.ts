import { RemoteAudioTrack, RemoteParticipant } from 'livekit-client';
import { SpeechmaticsStreamClient, SpeechmaticsConfig } from './speechmatics.js';
import { TranscriptManager } from './transcript-manager.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger({ component: 'AudioStreamManager' });

export class AudioStreamManager {
  private roomId: string;
  private speechmaticsConfig: SpeechmaticsConfig;
  private transcriptManager: TranscriptManager;
  private activeSessions: Map<string, SpeechmaticsStreamClient> = new Map();
  private audioProcessors: Map<string, AudioProcessor> = new Map();

  constructor(
    roomId: string,
    speechmaticsConfig: SpeechmaticsConfig,
    transcriptManager: TranscriptManager
  ) {
    this.roomId = roomId;
    this.speechmaticsConfig = speechmaticsConfig;
    this.transcriptManager = transcriptManager;
  }

  async handleParticipantTrack(
    participant: RemoteParticipant,
    track: RemoteAudioTrack,
    participantId: string
  ): Promise<void> {
    const sessionKey = `${participant.identity}-${track.sid}`;

    if (this.activeSessions.has(sessionKey)) {
      logger.warn({ sessionKey }, 'Session already exists for this participant track');
      return;
    }

    logger.info(
      {
        participantId,
        participantIdentity: participant.identity,
        trackSid: track.sid,
      },
      'Starting new Speechmatics session for participant'
    );

    const client = new SpeechmaticsStreamClient(
      this.roomId,
      participantId,
      this.speechmaticsConfig,
      this.transcriptManager
    );

    try {
      await client.start();
      this.activeSessions.set(sessionKey, client);

      const processor = new AudioProcessor(track, (audioData) => {
        client.sendAudio(audioData);
      });

      await processor.start();
      this.audioProcessors.set(sessionKey, processor);

      logger.info({ sessionKey, participantId }, 'Successfully started audio processing for participant');
    } catch (error) {
      logger.error({ error, sessionKey, participantId }, 'Failed to start Speechmatics session');
      throw error;
    }
  }

  async handleParticipantDisconnected(participantIdentity: string): Promise<void> {
    logger.info({ participantIdentity }, 'Participant disconnected, cleaning up sessions');

    const sessionsToRemove: string[] = [];

    for (const [sessionKey, _] of this.activeSessions) {
      if (sessionKey.startsWith(participantIdentity)) {
        sessionsToRemove.push(sessionKey);
      }
    }

    for (const sessionKey of sessionsToRemove) {
      await this.stopSession(sessionKey);
    }
  }

  async stopSession(sessionKey: string): Promise<void> {
    const client = this.activeSessions.get(sessionKey);
    const processor = this.audioProcessors.get(sessionKey);

    if (processor) {
      await processor.stop();
      this.audioProcessors.delete(sessionKey);
    }

    if (client) {
      await client.stop();
      this.activeSessions.delete(sessionKey);
    }

    logger.info({ sessionKey }, 'Stopped session');
  }

  async stopAll(): Promise<void> {
    logger.info({ count: this.activeSessions.size }, 'Stopping all Speechmatics sessions');

    const stopPromises: Promise<void>[] = [];

    for (const sessionKey of this.activeSessions.keys()) {
      stopPromises.push(this.stopSession(sessionKey));
    }

    await Promise.all(stopPromises);

    logger.info('All sessions stopped');
  }

  getActiveSessionCount(): number {
    return this.activeSessions.size;
  }
}

class AudioProcessor {
  private track: RemoteAudioTrack;
  private onAudioData: (data: Buffer) => void;
  private isRunning: boolean = false;

  constructor(track: RemoteAudioTrack, onAudioData: (data: Buffer) => void) {
    this.track = track;
    this.onAudioData = onAudioData;
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    logger.warn(
      'Audio processing in Node.js worker requires additional setup. This is a placeholder implementation.'
    );

    this.isRunning = true;
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
  }
}
