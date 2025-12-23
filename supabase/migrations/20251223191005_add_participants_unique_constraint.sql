/*
  # Add unique constraint to participants table

  1. Changes
    - Add unique constraint on (room_id, identity) to participants table
    - This ensures a participant with a specific identity can only exist once per room
    - Required for upsert operations in the LiveKit room client

  2. Security
    - No RLS changes needed (table already has RLS enabled)

  3. Notes
    - This constraint is required for the `onConflict` clause in participant upsert operations
    - No data conflicts exist in the current database
*/

-- Add unique constraint on room_id and identity
ALTER TABLE participants 
  ADD CONSTRAINT participants_room_id_identity_key 
  UNIQUE (room_id, identity);
