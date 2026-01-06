/*
  # Fix worker room ID clearing bug

  ## Problem
  Workers that finish processing rooms remain stuck with old `current_room_id` values.
  When a room ends, the worker tries to clear its `current_room_id` by sending NULL,
  but the `COALESCE` function keeps the old value instead of clearing it.

  ## Changes
  - Update `update_worker_heartbeat` function to allow NULL values for `current_room_id`
  - Remove COALESCE that was preventing workers from clearing their room assignment
  
  ## Impact
  - Workers will now properly clear `current_room_id` when they finish processing rooms
  - Workers will correctly show as available for new room assignments
*/

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
    current_room_id = p_room_id,
    status = 'active'
  WHERE id = p_worker_id;
END;
$$;
