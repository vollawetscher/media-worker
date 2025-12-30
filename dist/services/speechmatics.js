import WebSocket from 'ws';
import { getSupabase } from '../lib/supabase.js';
import { createLogger } from '../lib/logger.js';
const logger = createLogger({ component: 'SpeechmaticsStreamClient' });
export class SpeechmaticsStreamClient {
    ws = null;
    sessionId;
    participantId;
    roomId;
    config;
    transcriptManager;
    isActive = false;
    sessionDbId = null;
    transcriptCount = 0;
    confidenceSum = 0;
    startTime = null;
    constructor(roomId, participantId, config, transcriptManager) {
        this.roomId = roomId;
        this.participantId = participantId;
        this.config = config;
        this.transcriptManager = transcriptManager;
        this.sessionId = `${participantId}-${Date.now()}`;
    }
    async start() {
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
                this.ws.on('message', (data) => {
                    this.handleMessage(data);
                });
                this.ws.on('error', (error) => {
                    logger.error({ error, sessionId: this.sessionId }, 'WebSocket error');
                    this.updateSessionStatus('failed', error.message);
                    if (!this.isActive) {
                        reject(error);
                    }
                });
                this.ws.on('close', () => {
                    logger.info({ sessionId: this.sessionId }, 'WebSocket closed');
                    this.isActive = false;
                });
            }
            catch (error) {
                reject(error);
            }
        });
    }
    sendAudio(audioData) {
        if (!this.isActive || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
            return;
        }
        this.ws.send(audioData);
    }
    async stop() {
        if (!this.isActive || !this.ws) {
            return;
        }
        logger.info({ sessionId: this.sessionId }, 'Stopping Speechmatics session');
        this.ws.send(JSON.stringify({ message: 'EndOfStream' }));
        await new Promise((resolve) => setTimeout(resolve, 500));
        this.ws?.close();
        this.isActive = false;
        await this.finalizeSessionRecord();
    }
    handleMessage(data) {
        try {
            const message = JSON.parse(data.toString());
            if (message.message === 'RecognitionStarted') {
                logger.info({ sessionId: this.sessionId }, 'Recognition started');
                this.updateSessionStatus('active');
            }
            else if (message.message === 'AddPartialTranscript' && this.config.enablePartials) {
                this.handleTranscript(message, false);
            }
            else if (message.message === 'AddTranscript') {
                this.handleTranscript(message, true);
            }
            else if (message.message === 'EndOfTranscript') {
                logger.info({ sessionId: this.sessionId }, 'End of transcript');
            }
        }
        catch (error) {
            logger.error({ error, sessionId: this.sessionId }, 'Error handling Speechmatics message');
        }
    }
    handleTranscript(message, isFinal) {
        if (!message.metadata) {
            return;
        }
        const text = message.metadata.transcript;
        if (!text || text.trim().length === 0) {
            return;
        }
        const confidence = message.results
            ? message.results.reduce((sum, r) => sum + (r.alternatives[0]?.confidence || 0), 0) / message.results.length
            : 0.8;
        this.transcriptCount++;
        this.confidenceSum += confidence;
        this.transcriptManager.writeTranscript({
            speechmaticsSessionId: this.sessionDbId,
            participantId: this.participantId,
            text,
            isFinal,
            confidence,
            startTime: message.metadata.start_time,
            endTime: message.metadata.end_time,
            language: this.config.language,
        });
        logger.debug({
            sessionId: this.sessionId,
            isFinal,
            confidence,
            textLength: text.length,
        }, 'Transcript received');
    }
    async createSessionRecord() {
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
    async updateSessionStatus(status, errorMessage) {
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
    async finalizeSessionRecord() {
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
        logger.info({
            sessionId: this.sessionId,
            audioMinutes,
            transcriptCount: this.transcriptCount,
            avgConfidence,
        }, 'Finalized session record');
    }
    isRunning() {
        return this.isActive;
    }
}
//# sourceMappingURL=speechmatics.js.map