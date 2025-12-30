/*
  # Allow Workers to Claim Active Rooms

  1. Changes
    - Update `claim_room_for_worker` to accept both "pending" AND "active" rooms
    - Workers can now claim rooms that already have participants

  2. Reason
    - When participants join quickly (before worker polls), room becomes "active"
    - Workers need to claim "active" rooms to process ongoing calls
    - Previous restriction to "pending" only prevented legitimate claims

  3. Security
    - Maintains atomic claim logic (prevents race conditions)
    - Still respects worker heartbeat timeout (45 seconds)
    - Only allows unclaimed or stale rooms to be claimed
*/

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
    AND status IN ('pending', 'active');

  -- Check if we successfully claimed the room
  GET DIAGNOSTICS v_claimed = ROW_COUNT;

  RETURN v_claimed > 0;
END;
$$;
