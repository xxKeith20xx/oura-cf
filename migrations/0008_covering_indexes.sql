-- Migration: Add covering indexes to reduce D1 rows_read for Grafana queries
-- Problem: Grafana dashboard queries scan full rows from daily_summaries even when
-- only a few columns are needed. Covering indexes let SQLite satisfy queries entirely
-- from the index without touching the main table (76+ columns per row).

-- Readiness trend panels: readiness_score over time
CREATE INDEX IF NOT EXISTS idx_daily_readiness
ON daily_summaries(day, readiness_score)
WHERE readiness_score IS NOT NULL;

-- Sleep trend panels: sleep_score, sleep_efficiency over time
CREATE INDEX IF NOT EXISTS idx_daily_sleep
ON daily_summaries(day, sleep_score, sleep_efficiency)
WHERE sleep_score IS NOT NULL;

-- Activity trend panels: activity_score, steps, calories over time
CREATE INDEX IF NOT EXISTS idx_daily_activity
ON daily_summaries(day, activity_score, activity_steps, activity_active_calories)
WHERE activity_score IS NOT NULL;

-- Stress/resilience panels
CREATE INDEX IF NOT EXISTS idx_daily_stress
ON daily_summaries(day, stress_index, resilience_level)
WHERE stress_index IS NOT NULL;

-- Heart rate panels: queries filter by timestamp range and read bpm
-- timestamp is already PK, this adds bpm as a covering column
CREATE INDEX IF NOT EXISTS idx_hr_timestamp_bpm
ON heart_rate_samples(timestamp, bpm);

-- Sleep episodes: queries filter by day and read type + durations
CREATE INDEX IF NOT EXISTS idx_sleep_episodes_day_type
ON sleep_episodes(day, type, deep_duration, rem_duration, light_duration, awake_duration);

-- Activity logs: workout queries filter by type + time range
CREATE INDEX IF NOT EXISTS idx_activity_logs_type_start
ON activity_logs(type, start_datetime, activity_label, calories);
