-- Migration: Drop unused tables
-- oura_raw_documents: Created in 0001_init but never referenced in application code.
-- Indexes were already dropped in 0007_optimize_indexes.
-- oura_sync_state: Created in 0001_init but never referenced in application code.
-- The app uses next_token pagination from Oura API responses directly, not this table.

DROP TABLE IF EXISTS oura_raw_documents;
DROP TABLE IF EXISTS oura_sync_state;
