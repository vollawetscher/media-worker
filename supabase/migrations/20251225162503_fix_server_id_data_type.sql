/*
  # Fix server_id data type mismatch
  
  1. Changes
    - Change rooms.server_id from TEXT to UUID to match livekit_servers.id
    - This fixes the worker crash when loading LiveKit server configuration
  
  2. Notes
    - The comparison between TEXT and UUID was failing in PostgreSQL
    - Existing data will be cast to UUID during the migration
*/

-- Change server_id from TEXT to UUID
ALTER TABLE rooms 
  ALTER COLUMN server_id TYPE uuid USING server_id::uuid;
