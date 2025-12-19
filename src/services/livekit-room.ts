import {
  Room,
  RoomEvent,
  RemoteParticipant,
  RemoteTrack,
  RemoteTrackPublication,
  Track,
  RemoteAudioTrack,
} from 'livekit-client';
import { AccessToken } from 'livekit-server-sdk';
import { getSupabase } from '../lib/supabase.js';
import { createLogger } from '../lib/logger.js';
import { AudioStreamManager } from './audio-stream-manager.js';

const logger = createLogger({ component: 'LiveKitRoomClient' });

export interface LiveKitServerConfig {
  server_url: string;
  api_key: string;
  api_secret: string;
}

export class LiveKitRoomClient {
  private room: Room;
  private roomId: string;
  private roomName: string;
  private workerId: string;
  private serverConfig: LiveKitServerConfig;
  private audioStreamManager: AudioStreamManager;
  private participantMap: Map<string, string> = new Map();
  private onParticipantCountChange?: (count: number) => void;

  constructor(
    roomId: string,
    roomName: string,
    workerId: string,
    serverConfig: LiveKitServerConfig,
    audioStreamManager: AudioStreamManager
  ) {
    this.roomId = roomId;
    this.roomName = roomName;
    this.workerId = workerId;
    this.serverConfig = serverConfig;
    this.audioStreamManager = audioStreamManager;
    this.room = new Room();
  }

  setParticipantCountChangeHandler(handler: (count: number) => void): void {
    this.onParticipantCountChange = handler;
  }

  async connect(): Promise<void> {
    const token = await this.generateWorkerToken();

    logger.info(
      {
        roomName: this.roomName,
        serverUrl: this.serverConfig.server_url,
      },
      'Connecting to LiveKit room'
    );

    this.room.on(RoomEvent.ParticipantConnected, (participant: RemoteParticipant) => {
      this.handleParticipantConnected(participant);
    });

    this.room.on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
      this.handleParticipantDisconnected(participant);
    });

    this.room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
      this.handleTrackSubscribed(track, publication, participant);
    });

    this.room.on(RoomEvent.Disconnected, () => {
      logger.warn({ roomName: this.roomName }, 'Disconnected from LiveKit room');
    });

    await this.room.connect(this.serverConfig.server_url, token);

    logger.info(
      {
        roomName: this.roomName,
        participantCount: this.room.remoteParticipants.size,
      },
      'Successfully connected to LiveKit room'
    );

    for (const participant of this.room.remoteParticipants.values()) {
      await this.handleParticipantConnected(participant);
    }
  }

  private async generateWorkerToken(): Promise<string> {
    const token = new AccessToken(this.serverConfig.api_key, this.serverConfig.api_secret, {
      identity: `worker-${this.workerId}`,
      name: `Media Worker`,
      metadata: JSON.stringify({ worker: true, hidden: true }),
    });

    token.addGrant({
      room: this.roomName,
      roomJoin: true,
      canPublish: false,
      canSubscribe: true,
    });

    return await token.toJwt();
  }

  private async handleParticipantConnected(participant: RemoteParticipant): Promise<void> {
    const metadata = participant.metadata ? JSON.parse(participant.metadata) : {};

    if (metadata.worker === true) {
      logger.debug({ identity: participant.identity }, 'Ignoring worker participant');
      return;
    }

    logger.info(
      {
        identity: participant.identity,
        sid: participant.sid,
        metadata,
      },
      'Participant connected'
    );

    const participantId = await this.createOrUpdateParticipant(participant, 'joined');
    this.participantMap.set(participant.identity, participantId);

    for (const publication of participant.trackPublications.values()) {
      if (publication.track) {
        await this.handleTrackSubscribed(publication.track, publication, participant);
      }
    }

    this.notifyParticipantCountChange();
  }

  private async handleParticipantDisconnected(participant: RemoteParticipant): Promise<void> {
    logger.info({ identity: participant.identity }, 'Participant disconnected');

    await this.createOrUpdateParticipant(participant, 'left');
    await this.audioStreamManager.handleParticipantDisconnected(participant.identity);

    this.participantMap.delete(participant.identity);
    this.notifyParticipantCountChange();
  }

  private async handleTrackSubscribed(
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant
  ): Promise<void> {
    if (track.kind !== Track.Kind.Audio) {
      return;
    }

    const participantId = this.participantMap.get(participant.identity);
    if (!participantId) {
      logger.warn({ identity: participant.identity }, 'Participant ID not found for track subscription');
      return;
    }

    logger.info(
      {
        participantIdentity: participant.identity,
        trackSid: track.sid,
        trackKind: track.kind,
      },
      'Audio track subscribed'
    );

    await this.audioStreamManager.handleParticipantTrack(participant, track as RemoteAudioTrack, participantId);
  }

  private async createOrUpdateParticipant(participant: RemoteParticipant, event: 'joined' | 'left'): Promise<string> {
    const supabase = getSupabase();
    const metadata = participant.metadata ? JSON.parse(participant.metadata) : {};

    if (event === 'joined') {
      const { data, error } = await supabase
        .from('participants')
        .upsert(
          {
            room_id: this.roomId,
            identity: participant.identity,
            connection_type: metadata.connection_type || 'webrtc',
            phone_number: metadata.phone_number || null,
            joined_at: new Date().toISOString(),
            is_active: true,
            metadata: metadata,
          },
          { onConflict: 'room_id,identity' }
        )
        .select('id')
        .single();

      if (error) {
        logger.error({ error, identity: participant.identity }, 'Failed to create participant record');
        throw error;
      }

      return data.id;
    } else {
      const { data, error } = await supabase
        .from('participants')
        .update({
          left_at: new Date().toISOString(),
          is_active: false,
        })
        .eq('room_id', this.roomId)
        .eq('identity', participant.identity)
        .select('id')
        .single();

      if (error) {
        logger.error({ error, identity: participant.identity }, 'Failed to update participant record');
        throw error;
      }

      return data.id;
    }
  }

  private notifyParticipantCountChange(): void {
    const count = this.getHumanParticipantCount();
    this.onParticipantCountChange?.(count);
  }

  getHumanParticipantCount(): number {
    let count = 0;
    for (const participant of this.room.remoteParticipants.values()) {
      const metadata = participant.metadata ? JSON.parse(participant.metadata) : {};
      if (metadata.worker !== true) {
        count++;
      }
    }
    return count;
  }

  async disconnect(): Promise<void> {
    logger.info({ roomName: this.roomName }, 'Disconnecting from LiveKit room');
    await this.room.disconnect();
  }

  isConnected(): boolean {
    return this.room.state === 'connected';
  }
}
