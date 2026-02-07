-- Add indexes for Grafana query performance
CREATE INDEX IF NOT EXISTS idx_daily_summaries_day ON daily_summaries(day);
CREATE INDEX IF NOT EXISTS idx_sleep_episodes_day ON sleep_episodes(day);
CREATE INDEX IF NOT EXISTS idx_sleep_episodes_start_datetime ON sleep_episodes(start_datetime);
CREATE INDEX IF NOT EXISTS idx_activity_logs_start_datetime ON activity_logs(start_datetime);
CREATE INDEX IF NOT EXISTS idx_activity_logs_type ON activity_logs(type);
CREATE INDEX IF NOT EXISTS idx_heart_rate_samples_timestamp ON heart_rate_samples(timestamp);
