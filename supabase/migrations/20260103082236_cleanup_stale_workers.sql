/*
  # Add Stale Worker Cleanup Function

  1. New Function
    - `cleanup_stale_workers` - Marks workers as dead if heartbeat is too old and releases their rooms

  2. Purpose
    - Automatically clean up crashed/disconnected workers
    - Release rooms held by dead workers so new workers can claim them
    - Prevent accumulation of stale worker records

  3. Behavior
    - Marks workers as 'dead' if last_heartbeat > 45 seconds ago
    - Clears room assignments from dead workers
    - Returns count of workers cleaned up

  4. Security
    - Function is accessible to authenticated service role
    - Safe to call repeatedly (idempotent)
*/

CREATE OR REPLACE FUNCTION cleanup_stale_workers(
  p_stale_threshold_seconds INTEGER DEFAULT 45
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_cleaned_count INTEGER;
  v_stale_worker_ids UUID[];
BEGIN
  -- Find all stale workers
  SELECT ARRAY_AGG(id) INTO v_stale_worker_ids
  FROM media_workers
  WHERE status = 'active'
    AND last_heartbeat < NOW() - (p_stale_threshold_seconds || ' seconds')::INTERVAL;

  -- If no stale workers, return early
  IF v_stale_worker_ids IS NULL THEN
    RETURN 0;
  END IF;

  -- Release rooms held by stale workers
  UPDATE rooms
  SET
    media_worker_id = NULL,
    worker_claimed_at = NULL,
    media_worker_heartbeat = NULL
  WHERE media_worker_id = ANY(v_stale_worker_ids);

  -- Mark stale workers as dead
  UPDATE media_workers
  SET
    status = 'dead',
    current_room_id = NULL
  WHERE id = ANY(v_stale_worker_ids);

  -- Get count of cleaned workers
  GET DIAGNOSTICS v_cleaned_count = ROW_COUNT;

  RETURN v_cleaned_count;
END;
$$;