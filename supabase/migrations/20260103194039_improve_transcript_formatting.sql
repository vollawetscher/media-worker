/*
  # Improve Transcript Formatting Function

  1. Changes
    - Better cleaning of leading/trailing punctuation
    - Improved grouping logic to merge consecutive messages
    - Filter out very short fragments that are just punctuation
*/

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
      COALESCE(p.display_name, p.identity) as display_name,
      REGEXP_REPLACE(
        REGEXP_REPLACE(TRIM(t.transcript_text), '^[[:punct:][:space:]]+', ''),
        '[[:punct:][:space:]]+$', ''
      ) as cleaned_text,
      t.relative_timestamp,
      t.timestamp,
      LAG(t.participant_id) OVER (ORDER BY t.relative_timestamp) as prev_participant,
      LEAD(t.relative_timestamp) OVER (ORDER BY t.relative_timestamp) as next_timestamp
    FROM transcriptions t
    JOIN participants p ON t.participant_id = p.id
    WHERE t.room_id = p_room_id
      AND t.is_final = true
      AND LENGTH(TRIM(t.transcript_text)) > 0
    ORDER BY t.relative_timestamp
  ),
  filtered_transcripts AS (
    SELECT 
      participant_id,
      display_name,
      cleaned_text,
      relative_timestamp,
      timestamp,
      prev_participant,
      next_timestamp,
      CASE 
        WHEN participant_id != COALESCE(prev_participant, '00000000-0000-0000-0000-000000000000'::uuid)
          OR (next_timestamp IS NOT NULL AND next_timestamp - relative_timestamp > 2)
        THEN 1 
        ELSE 0 
      END as new_speaker
    FROM cleaned_transcripts
    WHERE LENGTH(cleaned_text) > 0
      AND cleaned_text !~ '^[[:punct:]]+$'
  ),
  speaker_groups AS (
    SELECT 
      participant_id,
      display_name,
      cleaned_text,
      relative_timestamp,
      timestamp,
      SUM(new_speaker) OVER (ORDER BY relative_timestamp) as group_id
    FROM filtered_transcripts
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