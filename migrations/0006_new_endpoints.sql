-- Migration: Add tables and columns for Oura API v1.28 endpoints
-- New endpoints: enhanced_tag, rest_mode_period, sleep_time

-- Enhanced tags: richer tag model with duration support and custom names
CREATE TABLE IF NOT EXISTS enhanced_tags (
    id TEXT PRIMARY KEY,
    start_day DATE NOT NULL,
    end_day DATE,
    start_time TEXT,
    end_time TEXT,
    tag_type_code TEXT,
    custom_name TEXT,
    comment TEXT
);

CREATE INDEX IF NOT EXISTS idx_enhanced_tags_start_day ON enhanced_tags(start_day);

-- Rest mode periods: tracks when user activates rest mode
CREATE TABLE IF NOT EXISTS rest_mode_periods (
    id TEXT PRIMARY KEY,
    start_day DATE NOT NULL,
    end_day DATE,
    start_time TEXT,
    end_time TEXT,
    episodes_json TEXT  -- JSON array of episode objects (tags during rest mode)
);

CREATE INDEX IF NOT EXISTS idx_rest_mode_periods_start_day ON rest_mode_periods(start_day);

-- Sleep time recommendations: daily optimal bedtime data
-- Keyed by day, fits naturally into daily_summaries
ALTER TABLE daily_summaries ADD COLUMN sleep_time_optimal_bedtime TEXT;
ALTER TABLE daily_summaries ADD COLUMN sleep_time_recommendation TEXT;
ALTER TABLE daily_summaries ADD COLUMN sleep_time_status TEXT;
