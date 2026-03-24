-- Migration 0010: Drop user_tags table
-- Superseded by enhanced_tags (added in 0006). The tag endpoint handler has been
-- removed from the sync engine; enhanced_tag is the canonical source for tag data.
DROP TABLE IF EXISTS user_tags;
