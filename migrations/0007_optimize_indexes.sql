-- Optimization: Drop redundant indexes that duplicate primary keys
-- daily_summaries.day IS the PRIMARY KEY, so idx_daily_summaries_day is redundant
DROP INDEX IF EXISTS idx_daily_summaries_day;

-- heart_rate_samples.timestamp IS the PRIMARY KEY, so idx_heart_rate_samples_timestamp is redundant
DROP INDEX IF EXISTS idx_heart_rate_samples_timestamp;

-- Drop indexes on unused tables (oura_raw_documents is never referenced in application code)
DROP INDEX IF EXISTS idx_oura_raw_documents_resource_day;
DROP INDEX IF EXISTS idx_oura_raw_documents_resource_start_at;

-- Add missing index: user_tags.day has no index but other day-based tables do
CREATE INDEX IF NOT EXISTS idx_user_tags_day ON user_tags(day);
