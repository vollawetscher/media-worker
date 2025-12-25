import { RemoteTrack, RemoteParticipant, AudioFrame, AudioStream } from '@livekit/rtc-node';
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
    track: RemoteTrack,
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
  private track: RemoteTrack;
  private onAudioData: (data: Buffer) => void;
  private isRunning: boolean = false;
  private processingTask: Promise<void> | null = null;

  constructor(track: RemoteTrack, onAudioData: (data: Buffer) => void) {
    this.track = track;
    this.onAudioData = onAudioData;
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;

    logger.info({ trackSid: this.track.sid }, 'Starting audio frame processing');

    this.processingTask = this.processAudioFrames();
  }

  private async processAudioFrames(): Promise<void> {
    const audioStream = new AudioStream(this.track, 16000, 1);
    const reader = audioStream.getReader();

    try {
      while (this.isRunning) {
        const { done, value } = await reader.read();

        if (done) {
          logger.info({ trackSid: this.track.sid }, 'Audio stream ended');
          break;
        }

        if (value) {
          const pcmData = this.convertFrameToPCM(value);
          this.onAudioData(pcmData);
        }
      }
    } catch (error) {
      if (this.isRunning) {
        logger.error({ error, trackSid: this.track.sid }, 'Error processing audio frames');
      }
    } finally {
      reader.releaseLock();
    }
  }

  private convertFrameToPCM(frame: AudioFrame): Buffer {
    const data = frame.data;

    if (frame.channels === 1) {
      return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    } else if (frame.channels === 2) {
      const monoSamples = new Int16Array(frame.samplesPerChannel);
      for (let i = 0; i < frame.samplesPerChannel; i++) {
        monoSamples[i] = Math.floor((data[i * 2] + data[i * 2 + 1]) / 2);
      }
      return Buffer.from(monoSamples.buffer, monoSamples.byteOffset, monoSamples.byteLength);
    }

    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    logger.info({ trackSid: this.track.sid }, 'Stopping audio frame processing');
    this.isRunning = false;

    if (this.processingTask) {
      await this.processingTask;
      this.processingTask = null;
    }
  }
}
