/*
  # Add Room Notification Triggers

  1. Overview
    - Creates database triggers that send notifications when rooms become available
    - Provides redundant notification mechanism alongside Supabase Realtime
    - Workers can LISTEN to 'room_available' channel for instant notifications

  2. Changes
    - Creates trigger function `notify_room_available()` that sends pg_notify
    - Adds INSERT trigger on rooms table to notify when new rooms are created
    - Adds UPDATE trigger on rooms table to notify when room becomes active
    - Notification payload includes room_id and new status

  3. Benefits
    - Redundant notification system if Realtime WebSocket fails
    - Lower latency than polling for room discovery
    - Native PostgreSQL feature with guaranteed delivery
    - Works with standard PostgreSQL LISTEN/NOTIFY protocol
*/

-- Create function to notify when room becomes available
CREATE OR REPLACE FUNCTION notify_room_available()
RETURNS TRIGGER AS $$
BEGIN
  -- Notify on INSERT (new room created)
  IF (TG_OP = 'INSERT') THEN
    PERFORM pg_notify(
      'room_available',
      json_build_object(
        'room_id', NEW.id,
        'room_name', NEW.room_name,
        'status', NEW.status,
        'event', 'INSERT'
      )::text
    );
    RETURN NEW;
  END IF;

  -- Notify on UPDATE when room becomes active or pending
  IF (TG_OP = 'UPDATE') THEN
    -- Notify if status changed to 'active' or 'pending'
    IF (NEW.status IN ('active', 'pending') AND OLD.status != NEW.status) THEN
      PERFORM pg_notify(
        'room_available',
        json_build_object(
          'room_id', NEW.id,
          'room_name', NEW.room_name,
          'status', NEW.status,
          'old_status', OLD.status,
          'event', 'UPDATE'
        )::text
      );
    END IF;

    -- Also notify if worker assignment cleared (room released)
    IF (NEW.media_worker_id IS NULL AND OLD.media_worker_id IS NOT NULL) THEN
      PERFORM pg_notify(
        'room_available',
        json_build_object(
          'room_id', NEW.id,
          'room_name', NEW.room_name,
          'status', NEW.status,
          'event', 'WORKER_RELEASED'
        )::text
      );
    END IF;

    RETURN NEW;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Drop existing triggers if they exist
DROP TRIGGER IF EXISTS rooms_insert_notify ON rooms;
DROP TRIGGER IF EXISTS rooms_update_notify ON rooms;

-- Create trigger for INSERT operations
CREATE TRIGGER rooms_insert_notify
  AFTER INSERT ON rooms
  FOR EACH ROW
  EXECUTE FUNCTION notify_room_available();

-- Create trigger for UPDATE operations
CREATE TRIGGER rooms_update_notify
  AFTER UPDATE ON rooms
  FOR EACH ROW
  EXECUTE FUNCTION notify_room_available();
