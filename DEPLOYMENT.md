# Deploying to Fly.io

This guide covers deploying the LiveKit Media Worker to Fly.io for production use.

## Prerequisites

1. Install the Fly.io CLI:
```bash
curl -L https://fly.io/install.sh | sh
```

2. Sign up or login to Fly.io:
```bash
fly auth signup
# or
fly auth login
```

## Initial Setup

### 1. Create Fly.io App

```bash
fly apps create livekit-media-worker
```

Or use a custom name:
```bash
fly apps create your-custom-name
```

Update the `app` name in `fly.toml` to match.

### 2. Set Environment Secrets

Set required secrets (these are NOT committed to git):

```bash
# Required: Supabase credentials
fly secrets set SUPABASE_URL="your_supabase_project_url"
fly secrets set SUPABASE_SERVICE_ROLE_KEY="your_service_role_key"

# Optional: Override defaults
fly secrets set MODE="both"
fly secrets set POLLING_INTERVAL_MS="3000"
fly secrets set HEARTBEAT_INTERVAL_MS="15000"
fly secrets set LOG_LEVEL="info"
```

**Get Supabase credentials:**
- `SUPABASE_URL`: Found in your Supabase project settings → API → Project URL
- `SUPABASE_SERVICE_ROLE_KEY`: Found in Supabase project settings → API → service_role key (keep this secret!)

### 3. Configure Worker Mode

The worker can run in three modes:

- `MODE=transcription` - Only processes LiveKit rooms and creates transcripts
- `MODE=ai-jobs` - Only processes AI analysis jobs
- `MODE=both` - Runs both transcription and AI job processing (default)

Set via:
```bash
fly secrets set MODE="both"
```

## Deploy

### First Deployment

```bash
fly deploy
```

This will:
1. Build the Docker image
2. Push to Fly.io registry
3. Deploy and start your worker

### Subsequent Deployments

```bash
fly deploy
```

## Scaling

### Horizontal Scaling

Deploy multiple worker instances for high availability and load distribution:

```bash
# Scale to 3 instances in the primary region
fly scale count 3

# Scale to 2 instances across multiple regions
fly scale count 2 --region iad,lhr
```

Workers automatically compete for rooms/jobs using atomic database operations. No coordination needed!

### Vertical Scaling

Adjust CPU and memory:

```bash
# List available VM sizes
fly platform vm-sizes

# Scale to larger VM
fly scale vm shared-cpu-2x

# Or edit fly.toml and redeploy
```

Recommended sizes:
- **Development**: `shared-cpu-1x` (256MB RAM)
- **Production (light)**: `shared-cpu-1x` (512MB-1GB RAM)
- **Production (heavy)**: `shared-cpu-2x` (2GB RAM)

### Dedicated Workers

Run separate deployments for transcription and AI jobs:

**Transcription workers** (create `fly.transcription.toml`):
```toml
app = "livekit-worker-transcription"
[env]
  MODE = "transcription"
```

Deploy:
```bash
fly deploy -c fly.transcription.toml
fly scale count 3 -a livekit-worker-transcription
```

**AI job workers** (create `fly.ai-jobs.toml`):
```toml
app = "livekit-worker-ai-jobs"
[env]
  MODE = "ai-jobs"
```

Deploy:
```bash
fly deploy -c fly.ai-jobs.toml
fly scale count 2 -a livekit-worker-ai-jobs
```

## Monitoring

### View Logs

Real-time logs:
```bash
fly logs
```

Search logs:
```bash
fly logs --search "error"
fly logs --search "workerId"
```

### Check Status

```bash
# App status
fly status

# VM metrics
fly vm status

# Scale info
fly scale show
```

### Database Monitoring

Connect to your Supabase database and run:

```sql
-- Active workers
SELECT * FROM media_workers WHERE status = 'active';

-- Stale workers (need cleanup)
SELECT * FROM media_workers
WHERE last_heartbeat < NOW() - INTERVAL '45 seconds';

-- Room processing status
SELECT status, COUNT(*) FROM rooms GROUP BY status;

-- Pending jobs
SELECT job_type, COUNT(*)
FROM post_call_jobs
WHERE status = 'pending'
GROUP BY job_type;
```

## Auto-Scaling (Optional)

Create autoscaling rules based on metrics:

```bash
# Scale based on CPU usage
fly autoscale set min=2 max=10

# Or configure in fly.toml
```

Add to `fly.toml`:
```toml
[autoscaling]
  min_machines = 2
  max_machines = 10
```

## Troubleshooting

### Workers Not Starting

```bash
fly logs

# Check if secrets are set
fly secrets list
```

### Workers Not Claiming Rooms

1. Verify database connection:
```bash
fly ssh console
node dist/index.js
```

2. Check Supabase RPC functions exist:
- `claim_room_for_worker()`
- `update_worker_heartbeat()`
- `release_room_from_worker()`

3. Verify rooms have correct status:
```sql
SELECT id, status, media_worker_id, media_worker_heartbeat
FROM rooms
WHERE status IN ('pending', 'active');
```

### High Memory Usage

1. Check for memory leaks in logs
2. Reduce VM count or switch to larger VMs
3. Monitor Speechmatics connections (should close after call ends)

### Connection Issues

Check network connectivity:
```bash
fly ssh console
ping eu2.rt.speechmatics.com
curl https://api.openai.com/v1/models
```

## Cost Optimization

**Tips to reduce costs:**

1. Use `shared-cpu-1x` VMs for light workloads
2. Scale down during off-hours:
   ```bash
   fly scale count 1
   ```
3. Use `MODE=transcription` and `MODE=ai-jobs` separately to scale independently
4. Monitor with `fly dashboard` to track resource usage

## Rollback

If deployment fails, rollback to previous version:

```bash
fly releases list
fly releases rollback <version>
```

## Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SUPABASE_URL` | Yes | - | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | - | Supabase service role key |
| `MODE` | No | `transcription` | Worker mode: `transcription`, `ai-jobs`, or `both` |
| `POLLING_INTERVAL_MS` | No | `3000` | How often to poll for rooms/jobs (ms) |
| `HEARTBEAT_INTERVAL_MS` | No | `15000` | Worker heartbeat interval (ms) |
| `LOG_LEVEL` | No | `info` | Logging level: `debug`, `info`, `warn`, `error` |
| `WORKER_ID` | No | auto-generated | Unique worker identifier (auto-generated if not set) |

## Production Checklist

- [ ] Supabase secrets configured
- [ ] Speechmatics API key added to `speechmatics_config` table
- [ ] OpenAI API key added to `ai_config` table
- [ ] Anthropic API key added to `ai_config` table (optional fallback)
- [ ] LiveKit server credentials added to `livekit_servers` table
- [ ] Database migrations applied
- [ ] RLS policies enabled on all tables
- [ ] At least 2 workers deployed for high availability
- [ ] Monitoring and alerting configured
- [ ] Logs aggregation set up (optional)

## Support

For issues with:
- **Fly.io platform**: [Fly.io Community](https://community.fly.io/)
- **Media Worker**: [GitHub Issues](https://github.com/vollawetscher/media-worker/issues)
