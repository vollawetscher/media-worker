/*
  # Fix claim_room_for_worker Type Error

  1. Changes
    - Fix `v_claimed` variable type from `boolean` to `integer`
    - Resolves "operator does not exist: boolean > integer" error

  2. Details
    - The `GET DIAGNOSTICS v_claimed = ROW_COUNT` assigns an integer
    - Need integer type to compare with `> 0` operator
*/

-- Recreate function with correct type
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
