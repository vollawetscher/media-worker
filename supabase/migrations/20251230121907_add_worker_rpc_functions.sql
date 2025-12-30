/*
  # Add Worker Management RPC Functions

  1. New Functions
    - `update_worker_heartbeat` - Updates worker heartbeat timestamp and current room
    - `claim_room_for_worker` - Atomically claims a room for a worker
    - `release_room_from_worker` - Releases a room from a worker

  2. Purpose
    - Enable stateless workers to coordinate room processing
    - Prevent race conditions when multiple workers compete for rooms
    - Track worker health via heartbeat timestamps

  3. Security
    - Functions are accessible to authenticated service role
    - Atomic operations prevent concurrent claim conflicts
*/

-- Update worker heartbeat and optionally set current room
CREATE OR REPLACE FUNCTION update_worker_heartbeat(
  p_worker_id UUID,
  p_room_id UUID DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE media_workers
  SET
    last_heartbeat = NOW(),
    current_room_id = COALESCE(p_room_id, current_room_id),
    status = 'active'
  WHERE id = p_worker_id;
END;
$$;

-- Atomically claim a room for a worker
CREATE OR REPLACE FUNCTION claim_room_for_worker(
  p_worker_id UUID,
  p_room_id UUID
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_claimed integer;
BEGIN
  -- Attempt to claim the room atomically
  UPDATE rooms
  SET
    media_worker_id = p_worker_id,
    worker_claimed_at = NOW(),
    media_worker_heartbeat = NOW(),
    status = 'processing'
  WHERE
    id = p_room_id
    AND (
      media_worker_id IS NULL
      OR media_worker_heartbeat < NOW() - INTERVAL '45 seconds'
    )
    AND status = 'pending';

  -- Check if we successfully claimed the room
  GET DIAGNOSTICS v_claimed = ROW_COUNT;

  RETURN v_claimed > 0;
END;
$$;

-- Release a room from a worker
CREATE OR REPLACE FUNCTION release_room_from_worker(
  p_worker_id UUID,
  p_room_id UUID
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE rooms
  SET
    media_worker_id = NULL,
    worker_claimed_at = NULL,
    media_worker_heartbeat = NULL
  WHERE
    id = p_room_id
    AND media_worker_id = p_worker_id;

  -- Update worker to clear current room
  UPDATE media_workers
  SET
    current_room_id = NULL
  WHERE
    id = p_worker_id
    AND current_room_id = p_room_id;
END;
$$;