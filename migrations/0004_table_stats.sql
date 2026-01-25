-- Migration: Add table_stats for pre-computed metadata
-- This avoids scanning millions of heart_rate_samples rows on every stats query

CREATE TABLE IF NOT EXISTS table_stats (
  resource TEXT PRIMARY KEY,
  min_day TEXT,
  max_day TEXT,
  record_count INTEGER,
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Create index for fast lookups
CREATE INDEX IF NOT EXISTS idx_table_stats_updated ON table_stats(updated_at);
