/*
  # Fix claim_room_for_worker to update worker state atomically

  ## Problem
  When a worker claims a room, the function only updates the `rooms` table
  but leaves `media_workers.current_room_id` unchanged. This creates a race
  condition where:
  - `rooms.media_worker_id` shows worker is assigned to Room A
  - `media_workers.current_room_id` still shows old Room B (or NULL)
  
  The worker relies on the next heartbeat to sync this, creating a window
  of inconsistency that can last several seconds.

  ## Solution
  Update `claim_room_for_worker()` to atomically update BOTH tables:
  1. Set `rooms.media_worker_id` to claim the room
  2. Set `media_workers.current_room_id` to reflect the claim
  
  This ensures database consistency from the moment a room is claimed.

  ## Changes
  - Modified `claim_room_for_worker()` to update both tables atomically
  - Worker state is now immediately consistent with room assignment
  - Eliminates race condition between claim and first heartbeat
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

  -- If claim was successful, update worker's current_room_id
  IF v_claimed > 0 THEN
    UPDATE media_workers
    SET
      current_room_id = p_room_id,
      last_heartbeat = NOW()
    WHERE id = p_worker_id;
  END IF;

  RETURN v_claimed > 0;
END;
$$;