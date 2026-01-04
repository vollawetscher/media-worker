# LiveKit Media Worker

 Stateless worker for processing LiveKit rooms with real-time Speech-to-Text (Speechmatics) and AI analysis (OpenAI/Anthropic).

**Repository**: [https://github.com/vollawetscher/media-worker](https://github.com/vollawetscher/media-worker)

## Quick Start

```bash
# Clone and install
git clone https://github.com/vollawetscher/media-worker.git
cd media-worker
npm install

# Configure
cp .env.example .env
# Edit .env with your Supabase credentials

# Run locally
npm run dev

# Deploy to Fly.io
fly auth login
fly secrets set SUPABASE_URL="your_url" SUPABASE_SERVICE_ROLE_KEY="your_key"
fly deploy
```

## Features

- **Stateless Architecture**: All state stored in Supabase database
- **Monotonic Timebase (t0)**: Perfect alignment of multi-speaker transcripts
- **Real-Time STT**: Separate Speechmatics session per participant
- **AI Job Processing**: Post-call analysis with OpenAI (Anthropic fallback)
- **Atomic Room Claiming**: Multiple workers compete for rooms safely
- **Automatic Failover**: Crashed workers are detected and rooms reassigned
- **Horizontal Scaling**: Deploy multiple instances for load distribution

## Architecture

### Stateless Design

Workers are completely stateless. All room state, transcripts, and configuration are stored in Supabase. If a worker crashes:

1. Heartbeat timeout (45 seconds) is detected
2. Room becomes available for another worker
3. New worker claims room and continues processing
4. Timeline reconstruction uses relative timestamps from t0

### Event-Driven Architecture

The system uses a webhook-driven architecture:

1. **LiveKit Webhook**: Receives room lifecycle events from LiveKit
   - `room_started`: Creates room record in database
   - `participant_joined`: Updates room status to active
   - `room_finished`: Marks room complete and schedules AI jobs

2. **Workers**: Process rooms and jobs
   - Transcription workers claim pending rooms and process audio
   - AI job workers process post-call analysis tasks
   - Workers never schedule jobs (webhook handles this)

### Monotonic Timebase (t0)

When a worker joins a room, it establishes or loads a timebase origin (t0) stored in `rooms.timebase_started_at`. All timestamps are converted to seconds from t0:

- Each participant has separate Speechmatics session
- All transcripts timestamped relative to t0
- AI voice agent responses timestamped relative to t0
- Post-call analysis reconstructs perfect timeline

### Worker Modes

1. **transcription**: Processes LiveKit rooms, creates transcripts
2. **ai-jobs**: Processes post-call AI analysis jobs
3. **both**: Runs both modes in single worker

## Setup

### 1. Clone and Install Dependencies

```bash
git clone https://github.com/vollawetscher/media-worker.git
cd media-worker
npm install
```

### 2. Configure Environment

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Edit `.env`:

```env
SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
MODE=transcription
POLLING_INTERVAL_MS=3000
HEARTBEAT_INTERVAL_MS=15000
LOG_LEVEL=info
```

### 3. Deploy Supabase Edge Functions

The system requires a webhook endpoint to receive LiveKit events:

```bash
# Deploy the LiveKit webhook function
supabase functions deploy livekit-webhook
```

Configure your LiveKit server to send webhooks to:
```
https://your-project.supabase.co/functions/v1/livekit-webhook
```

### 4. Configure Services in Database

#### Speechmatics Configuration

Insert your Speechmatics API key:

```sql
INSERT INTO speechmatics_config (api_key, default_language, enable_partials, operating_point)
VALUES ('your_speechmatics_api_key', 'en', true, 'standard');
```

#### AI Configuration

Insert OpenAI (primary) and Anthropic (fallback):

```sql
INSERT INTO ai_config (service_name, api_key, model_name, priority, is_active, use_case)
VALUES
  ('openai', 'sk-...', 'gpt-4', 100, true, 'post-call-analysis'),
  ('anthropic', 'sk-ant-...', 'claude-3-5-sonnet-20241022', 90, true, 'post-call-analysis');
```

### 5. Run Worker

Development:
```bash
npm run dev
```

Production:
```bash
npm run build
npm start
```

With specific mode:
```bash
npm run start:transcription
npm run start:ai-jobs
```

## How It Works

### LiveKit Webhook

1. **Room Started**: LiveKit sends webhook when room is created
   - Webhook creates room record with `status='pending'`
   - Room becomes available for worker claim

2. **Participant Joined**: LiveKit sends webhook when first participant joins
   - Webhook updates room to `status='active'`

3. **Room Finished**: LiveKit sends webhook when room closes
   - Webhook updates room to `status='completed'`
   - **Webhook schedules all post-call AI jobs** (summary, action items, sentiment, speaker analytics)

### Transcription Mode

1. **Poll for Rooms**: Worker queries for rooms with `status='pending'` and no active worker
2. **Atomic Claim**: Uses `claim_room_for_worker()` RPC to atomically claim room
3. **Initialize Timebase**: Establish or load t0 from database
4. **Connect to LiveKit**: Join room as hidden worker participant
5. **Process Participants**: Create Speechmatics session for each participant's audio
6. **Write Transcripts**: Save transcripts with `relative_timestamp` from t0
7. **Monitor for End**: Empty room timeout or explicit room close
8. **Cleanup**: Close sessions, mark participants inactive, finalize room
9. **Release Room**: Release claim from worker
10. **Repeat**: Poll for next room

**Note**: Workers do NOT schedule AI jobs. Job scheduling is handled exclusively by the webhook to prevent race conditions.

### AI Jobs Mode

1. **Poll for Jobs**: Query `post_call_jobs` WHERE `status='pending'` ORDER BY priority
2. **Claim Job**: Atomically update status to 'claimed'
3. **Load Context**: Fetch transcripts (ordered by relative_timestamp) and participants
4. **Try OpenAI**: Call OpenAI API with job-specific prompt
5. **Fallback to Anthropic**: If OpenAI fails, try Anthropic
6. **Save Results**: Store output in `output_data`, log interaction
7. **Retry Logic**: Up to 3 retries for failed jobs
8. **Repeat**: Poll for next job

## Deployment

### Fly.io (Recommended)

Quick deploy to Fly.io:

```bash
# Install Fly CLI and login
fly auth login

# Set secrets
fly secrets set SUPABASE_URL="your_url"
fly secrets set SUPABASE_SERVICE_ROLE_KEY="your_key"

# Deploy
fly deploy

# Scale to multiple instances
fly scale count 3
```

**See [DEPLOYMENT.md](./DEPLOYMENT.md) for complete Fly.io deployment guide.**

### Docker

Build image:
```bash
docker build -t livekit-media-worker .
```

Run container:
```bash
docker run -e SUPABASE_URL="..." -e SUPABASE_SERVICE_ROLE_KEY="..." livekit-media-worker
```

### Scaling

Deploy multiple worker instances for high availability and load distribution:

```bash
docker run -e MODE=transcription livekit-media-worker &
docker run -e MODE=transcription livekit-media-worker &
docker run -e MODE=ai-jobs livekit-media-worker &
```

Workers automatically:
- Compete for available rooms (atomic claiming)
- Detect and recover from peer failures (heartbeat timeout)
- Balance load across instances
- Process jobs in priority order

### Kubernetes

See `k8s/` directory for Kubernetes manifests (HorizontalPodAutoscaler, Deployment, Service).

## Monitoring

### Health Metrics

Workers log structured JSON with:
- `workerId`: Unique worker identifier
- `roomId`: Current room being processed
- `component`: Service component generating log

### Database Monitoring

Query active workers:
```sql
SELECT * FROM media_workers WHERE status = 'active';
```

Query stale workers (missed heartbeat):
```sql
SELECT * FROM media_workers WHERE last_heartbeat < NOW() - INTERVAL '45 seconds';
```

Query pending jobs:
```sql
SELECT job_type, COUNT(*) FROM post_call_jobs WHERE status = 'pending' GROUP BY job_type;
```

Query room processing status:
```sql
SELECT status, COUNT(*) FROM rooms GROUP BY status;
```

## Troubleshooting

### Worker Not Claiming Rooms

- Check `status='pending'` in rooms table
- Verify `media_worker_id IS NULL` or stale heartbeat
- Check worker logs for claim failures
- Ensure RPC functions exist: `claim_room_for_worker()`, `update_worker_heartbeat()`

### Speechmatics Connection Failures

- Verify API key in `speechmatics_config` table
- Check network connectivity to `eu2.rt.speechmatics.com`
- Review `speechmatics_sessions` table for error messages
- Check audio format configuration (PCM 16kHz required)

### Missing Transcripts

- Verify `timebase_started_at` is set in rooms table
- Check `relative_timestamp` is being calculated correctly
- Ensure `speechmatics_session_id` links to participants
- Review `transcript_count` in `speechmatics_sessions`

### AI Jobs Not Processing

- Verify active AI config: `SELECT * FROM ai_config WHERE is_active = true ORDER BY priority DESC`
- Check API keys are valid
- Review `ai_interactions` table for errors
- Ensure jobs have `status='pending'`

### Timebase Alignment Issues

- Verify all transcripts have `relative_timestamp` calculated from same t0
- Check `rooms.timebase_started_at` is set when worker connects
- Ensure clock sync across worker instances (use NTP)
- Review transcript ordering: `ORDER BY relative_timestamp ASC`

## Development

### Project Structure

```
src/
├── config/           # Configuration loading
│   └── index.ts
├── lib/              # Shared utilities
│   ├── logger.ts     # Structured logging
│   ├── supabase.ts   # Database client
│   └── timebase.ts   # Monotonic timestamp alignment
├── services/         # Core services
│   ├── audio-stream-manager.ts
│   ├── ai-job-processor.ts
│   ├── call-end-detector.ts
│   ├── livekit-room.ts
│   ├── post-call-job-scheduler.ts  # Used by webhook only
│   ├── room-poller.ts
│   ├── speechmatics.ts
│   ├── transcript-manager.ts
│   └── worker-manager.ts
└── index.ts          # Entry point

supabase/
├── functions/        # Edge Functions
│   ├── livekit-webhook/    # Handles LiveKit events
│   └── diagnostic/         # Health check endpoint
└── migrations/       # Database schema migrations
```

### Type Checking

```bash
npm run typecheck
```

### Adding New AI Providers

1. Add provider to `ai_config` table
2. Implement provider in `AIJobProcessor.callAI()`
3. Set priority for fallback order
4. Test with sample job

### Extending Job Types

1. Add job type to `post_call_jobs.job_type` enum in database
2. Add prompt template in `AIJobProcessor.buildPrompt()`
3. Update job creation in `supabase/functions/livekit-webhook/index.ts` (room_finished event handler)

## License

MIT
