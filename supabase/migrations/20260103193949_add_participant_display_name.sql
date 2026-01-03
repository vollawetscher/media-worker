/*
  # Add Display Name to Participants and Transcript Formatting

  1. Schema Changes
    - Add `display_name` column to `participants` table
    - Populate display names from existing metadata

  2. New Functions
    - `get_formatted_transcript(room_id)` - Returns human-readable transcript with speaker names
    - Groups consecutive messages by speaker
    - Filters out punctuation-only entries
    - Orders by timestamp

  3. Data Migration
    - Extract contact names from SIP participant metadata
    - Generate friendly names for web participants
*/

-- Add display_name column to participants
ALTER TABLE participants 
ADD COLUMN IF NOT EXISTS display_name TEXT;

-- Populate display names from existing data
UPDATE participants
SET display_name = CASE
  WHEN metadata->>'contactName' IS NOT NULL THEN metadata->>'contactName'
  WHEN metadata->>'phoneNumber' IS NOT NULL THEN metadata->>'phoneNumber'
  WHEN connection_type = 'sip' THEN COALESCE(phone_number, 'Phone User')
  WHEN identity LIKE 'web-%' THEN 'Web User'
  WHEN identity LIKE 'sip-call-%' THEN COALESCE(metadata->>'contactName', metadata->>'phoneNumber', 'Phone User')
  ELSE identity
END
WHERE display_name IS NULL;

-- Create function to get formatted transcript
CREATE OR REPLACE FUNCTION get_formatted_transcript(p_room_id UUID)
RETURNS TABLE (
  speaker_name TEXT,
  message TEXT,
  start_timestamp NUMERIC,
  end_timestamp NUMERIC,
  message_time TIMESTAMPTZ
) 
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  WITH cleaned_transcripts AS (
    SELECT 
      t.participant_id,
      p.display_name,
      p.identity,
      TRIM(t.transcript_text) as cleaned_text,
      t.relative_timestamp,
      t.timestamp,
      t.confidence,
      LAG(t.participant_id) OVER (ORDER BY t.relative_timestamp) as prev_participant
    FROM transcriptions t
    JOIN participants p ON t.participant_id = p.id
    WHERE t.room_id = p_room_id
      AND t.is_final = true
      AND LENGTH(TRIM(t.transcript_text)) > 0
      AND TRIM(t.transcript_text) !~ '^[[:punct:]]+$'
    ORDER BY t.relative_timestamp
  ),
  grouped_messages AS (
    SELECT 
      participant_id,
      display_name,
      cleaned_text,
      relative_timestamp,
      timestamp,
      CASE 
        WHEN participant_id != COALESCE(prev_participant, '00000000-0000-0000-0000-000000000000'::uuid)
        THEN 1 
        ELSE 0 
      END as new_speaker
    FROM cleaned_transcripts
  ),
  speaker_groups AS (
    SELECT 
      participant_id,
      display_name,
      cleaned_text,
      relative_timestamp,
      timestamp,
      SUM(new_speaker) OVER (ORDER BY relative_timestamp) as group_id
    FROM grouped_messages
  )
  SELECT 
    display_name as speaker_name,
    STRING_AGG(cleaned_text, ' ' ORDER BY relative_timestamp) as message,
    MIN(relative_timestamp) as start_timestamp,
    MAX(relative_timestamp) as end_timestamp,
    MIN(timestamp) as message_time
  FROM speaker_groups
  GROUP BY group_id, display_name, participant_id
  ORDER BY start_timestamp;
END;
$$;