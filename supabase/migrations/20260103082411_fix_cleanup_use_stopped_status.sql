/*
  # Fix Stale Worker Cleanup Status

  1. Changes
    - Use 'stopped' status instead of 'dead' to comply with check constraint
    - Valid statuses are: active, idle, stopping, stopped

  2. Purpose
    - Ensure cleanup function works with existing status constraints
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

  -- Release rooms held by stale workers (cast UUID array to TEXT for comparison)
  UPDATE rooms
  SET
    media_worker_id = NULL,
    worker_claimed_at = NULL,
    media_worker_heartbeat = NULL
  WHERE media_worker_id = ANY(SELECT id::TEXT FROM media_workers WHERE id = ANY(v_stale_worker_ids));

  -- Mark stale workers as stopped
  UPDATE media_workers
  SET
    status = 'stopped',
    current_room_id = NULL
  WHERE id = ANY(v_stale_worker_ids);

  -- Get count of cleaned workers
  GET DIAGNOSTICS v_cleaned_count = ROW_COUNT;

  RETURN v_cleaned_count;
END;
$$;