import WebSocket from 'ws';
import { getSupabase } from '../lib/supabase.js';
import { createLogger } from '../lib/logger.js';
import type { TranscriptManager } from './transcript-manager.js';

const logger = createLogger({ component: 'SpeechmaticsStreamClient' });

export interface SpeechmaticsConfig {
  apiKey: string;
  language: string;
  enablePartials: boolean;
  operatingPoint: string;
}

export interface SpeechmaticsMessage {
  message: string;
  results?: Array<{
    alternatives: Array<{
      content: string;
      confidence: number;
      language?: string;
    }>;
    start_time?: number;
    end_time?: number;
    type: 'word' | 'punctuation';
  }>;
  metadata?: {
    transcript: string;
    start_time: number;
    end_time: number;
  };
}

export class SpeechmaticsStreamClient {
  private ws: WebSocket | null = null;
  private sessionId: string;
  private participantId: string;
  private roomId: string;
  private config: SpeechmaticsConfig;
  private transcriptManager: TranscriptManager;
  private isActive: boolean = false;
  private sessionDbId: string | null = null;
  private transcriptCount: number = 0;
  private confidenceSum: number = 0;
  private startTime: Date | null = null;
  private transcriptBuffer: string = '';
  private bufferStartTime: number | null = null;
  private bufferEndTime: number | null = null;
  private bufferConfidences: number[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly BUFFER_FLUSH_MS = 2000;

  constructor(
    roomId: string,
    participantId: string,
    config: SpeechmaticsConfig,
    transcriptManager: TranscriptManager
  ) {
    this.roomId = roomId;
    this.participantId = participantId;
    this.config = config;
    this.transcriptManager = transcriptManager;
    this.sessionId = `${participantId}-${Date.now()}`;
  }

  async start(): Promise<void> {
    if (this.isActive) {
      throw new Error('Session already active');
    }

    logger.info({ participantId: this.participantId, sessionId: this.sessionId }, 'Starting Speechmatics session');

    await this.createSessionRecord();
    this.startTime = new Date();

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket('wss://eu2.rt.speechmatics.com/v2', {
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
          },
        });

        this.ws.on('open', () => {
          logger.info({ sessionId: this.sessionId }, 'WebSocket connected');

          const startMessage = {
            message: 'StartRecognition',
            audio_format: {
              type: 'raw',
              encoding: 'pcm_s16le',
              sample_rate: 16000,
            },
            transcription_config: {
              language: this.config.language,
              operating_point: this.config.operatingPoint,
              enable_partials: this.config.enablePartials,
              max_delay: 2.0,
            },
          };

          this.ws?.send(JSON.stringify(startMessage));
          this.isActive = true;
          resolve();
        });

        this.ws.on('message', (data: WebSocket.Data) => {
          this.handleMessage(data);
        });

        this.ws.on('error', (error) => {
          logger.error({ error, sessionId: this.sessionId }, 'WebSocket error');
          this.updateSessionStatus('failed', error.message);
          if (!this.isActive) {
            reject(error);
          }
        });

        this.ws.on('close', (code: number, reason: Buffer) => {
          const reasonString = reason.toString();
          logger.warn(
            {
              sessionId: this.sessionId,
              code,
              reason: reasonString,
              wasActive: this.isActive
            },
            'WebSocket closed'
          );

          if (code !== 1000 && reasonString) {
            this.updateSessionStatus('failed', `WebSocket closed with code ${code}: ${reasonString}`);
          }

          this.isActive = false;
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  sendAudio(audioData: Buffer): void {
    if (!this.isActive || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    this.ws.send(audioData);
  }

  async stop(): Promise<void> {
    if (!this.isActive || !this.ws) {
      return;
    }

    logger.info({ sessionId: this.sessionId }, 'Stopping Speechmatics session');

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    this.flushBuffer();

    try {
      this.ws.send(Buffer.alloc(0));
    } catch (error) {
      logger.warn({ error, sessionId: this.sessionId }, 'Error sending EndOfStream');
    }

    await new Promise((resolve) => setTimeout(resolve, 500));

    // Remove all event listeners to prevent memory leaks
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }

    this.isActive = false;

    await this.finalizeSessionRecord();
  }

  private handleMessage(data: WebSocket.Data): void {
    try {
      const message: any = JSON.parse(data.toString());

      if (message.message === 'RecognitionStarted') {
        logger.info({ sessionId: this.sessionId }, 'Recognition started');
        this.updateSessionStatus('active');
      } else if (message.message === 'AddPartialTranscript' && this.config.enablePartials) {
        this.handleTranscript(message, false);
      } else if (message.message === 'AddTranscript') {
        this.handleTranscript(message, true);
      } else if (message.message === 'EndOfTranscript') {
        logger.info({ sessionId: this.sessionId }, 'End of transcript');
      } else if (message.message === 'Error') {
        logger.error(
          {
            sessionId: this.sessionId,
            errorType: message.type,
            reason: message.reason,
            fullMessage: message
          },
          'Speechmatics error received'
        );
        this.updateSessionStatus('failed', `Speechmatics error: ${message.reason || message.type}`);
      } else if (message.message === 'Warning') {
        logger.warn(
          {
            sessionId: this.sessionId,
            warningType: message.type,
            reason: message.reason
          },
          'Speechmatics warning received'
        );
      } else {
        logger.debug(
          {
            sessionId: this.sessionId,
            messageType: message.message,
            fullMessage: message
          },
          'Unhandled Speechmatics message'
        );
      }
    } catch (error) {
      logger.error({ error, sessionId: this.sessionId }, 'Error handling Speechmatics message');
    }
  }

  private handleTranscript(message: SpeechmaticsMessage, isFinal: boolean): void {
    if (!message.metadata || !isFinal) {
      return;
    }

    const text = message.metadata.transcript;
    if (!text || text.trim().length === 0) {
      return;
    }

    const confidence = message.results
      ? message.results.reduce((sum, r) => sum + (r.alternatives[0]?.confidence || 0), 0) / message.results.length
      : 0.8;

    this.bufferConfidences.push(confidence);

    if (this.bufferStartTime === null) {
      this.bufferStartTime = message.metadata.start_time;
    }
    this.bufferEndTime = message.metadata.end_time;

    if (this.transcriptBuffer.length > 0 && !this.transcriptBuffer.endsWith(' ')) {
      this.transcriptBuffer += ' ';
    }
    this.transcriptBuffer += text;

    const shouldFlush = this.shouldFlushBuffer(text);

    if (shouldFlush) {
      this.flushBuffer();
    } else {
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
      }
      this.flushTimer = setTimeout(() => this.flushBuffer(), this.BUFFER_FLUSH_MS);
    }

    logger.debug(
      {
        sessionId: this.sessionId,
        isFinal,
        confidence,
        textLength: text.length,
        bufferLength: this.transcriptBuffer.length,
        shouldFlush,
      },
      'Transcript received'
    );
  }

  private shouldFlushBuffer(text: string): boolean {
    const trimmedText = text.trim();
    const endsWithSentenceTerminator = /[.!?]$/.test(trimmedText);
    const bufferTooLong = this.transcriptBuffer.length > 500;

    return endsWithSentenceTerminator || bufferTooLong;
  }

  private flushBuffer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.transcriptBuffer.trim().length === 0) {
      return;
    }

    const avgConfidence = this.bufferConfidences.length > 0
      ? this.bufferConfidences.reduce((sum, c) => sum + c, 0) / this.bufferConfidences.length
      : 0.8;

    this.transcriptCount++;
    this.confidenceSum += avgConfidence;

    this.transcriptManager.writeTranscript({
      speechmaticsSessionId: this.sessionDbId!,
      participantId: this.participantId,
      text: this.transcriptBuffer.trim(),
      isFinal: true,
      confidence: avgConfidence,
      startTime: this.bufferStartTime!,
      endTime: this.bufferEndTime!,
      language: this.config.language,
    });

    logger.debug(
      {
        sessionId: this.sessionId,
        textLength: this.transcriptBuffer.length,
        confidence: avgConfidence,
      },
      'Flushed transcript buffer'
    );

    this.transcriptBuffer = '';
    this.bufferStartTime = null;
    this.bufferEndTime = null;
    this.bufferConfidences = [];
  }

  private async createSessionRecord(): Promise<void> {
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('speechmatics_sessions')
      .insert({
        room_id: this.roomId,
        participant_id: this.participantId,
        session_id: this.sessionId,
        status: 'active',
        started_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (error) {
      throw new Error(`Failed to create Speechmatics session record: ${error.message}`);
    }

    this.sessionDbId = data.id;
    logger.info({ sessionId: this.sessionId, sessionDbId: this.sessionDbId }, 'Created session record');
  }

  private async updateSessionStatus(status: string, errorMessage?: string): Promise<void> {
    if (!this.sessionDbId) {
      return;
    }

    const supabase = getSupabase();

    await supabase
      .from('speechmatics_sessions')
      .update({
        status,
        error_message: errorMessage || null,
      })
      .eq('id', this.sessionDbId);
  }

  private async finalizeSessionRecord(): Promise<void> {
    if (!this.sessionDbId || !this.startTime) {
      return;
    }

    const endTime = new Date();
    const durationMs = endTime.getTime() - this.startTime.getTime();
    const audioMinutes = durationMs / 1000 / 60;

    const avgConfidence = this.transcriptCount > 0 ? this.confidenceSum / this.transcriptCount : 0;

    const supabase = getSupabase();

    await supabase
      .from('speechmatics_sessions')
      .update({
        status: 'completed',
        ended_at: endTime.toISOString(),
        audio_minutes: audioMinutes,
        transcript_count: this.transcriptCount,
        average_confidence: avgConfidence,
      })
      .eq('id', this.sessionDbId);

    logger.info(
      {
        sessionId: this.sessionId,
        audioMinutes,
        transcriptCount: this.transcriptCount,
        avgConfidence,
      },
      'Finalized session record'
    );
  }

  isRunning(): boolean {
    return this.isActive;
  }
}
