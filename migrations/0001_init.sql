CREATE TABLE IF NOT EXISTS daily_summaries (
    day DATE PRIMARY KEY,
    readiness_score INTEGER,
    readiness_activity_balance INTEGER,
    readiness_body_temperature INTEGER,
    readiness_hrv_balance INTEGER,
    readiness_previous_day_activity INTEGER,
    readiness_previous_night_sleep INTEGER,
    readiness_recovery_index INTEGER,
    readiness_resting_heart_rate INTEGER,
    readiness_sleep_balance INTEGER,
    sleep_score INTEGER,
    sleep_deep_sleep INTEGER,
    sleep_efficiency INTEGER,
    sleep_latency INTEGER,
    sleep_rem_sleep INTEGER,
    sleep_restfulness INTEGER,
    sleep_timing INTEGER,
    sleep_total_sleep INTEGER,
    activity_score INTEGER,
    activity_steps INTEGER,
    activity_active_calories INTEGER,
    activity_total_calories INTEGER,
    activity_meet_daily_targets INTEGER,
    activity_move_every_hour INTEGER,
    activity_recovery_time INTEGER,
    activity_stay_active INTEGER,
    activity_training_frequency INTEGER,
    activity_training_volume INTEGER,
    stress_index INTEGER,
    resilience_level TEXT,
    resilience_contributors_sleep INTEGER,
    resilience_contributors_stress INTEGER,
    spo2_percentage REAL,
    spo2_breathing_disturbance_index INTEGER,
    cv_age_offset INTEGER,
    vo2_max REAL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS heart_rate_samples (
    timestamp DATETIME PRIMARY KEY,
    bpm INTEGER,
    source TEXT
);

CREATE TABLE IF NOT EXISTS sleep_episodes (
    id TEXT PRIMARY KEY,
    day DATE,
    start_datetime DATETIME,
    end_datetime DATETIME,
    type TEXT,
    heart_rate_avg REAL,
    heart_rate_lowest REAL,
    hrv_avg REAL,
    breath_avg REAL,
    temperature_deviation REAL,
    deep_duration INTEGER,
    rem_duration INTEGER,
    light_duration INTEGER,
    awake_duration INTEGER
);

CREATE TABLE IF NOT EXISTS activity_logs (
    id TEXT PRIMARY KEY,
    type TEXT,
    start_datetime DATETIME,
    end_datetime DATETIME,
    activity_label TEXT,
    intensity TEXT,
    calories REAL,
    distance REAL,
    hr_avg REAL,
    mood TEXT
);

CREATE TABLE IF NOT EXISTS user_tags (
    id TEXT PRIMARY KEY,
    day DATE,
    tag_type TEXT,
    comment TEXT
);

CREATE TABLE IF NOT EXISTS oura_raw_documents (
    user_id TEXT NOT NULL,
    resource TEXT NOT NULL,
    document_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    day TEXT,
    start_at TEXT,
    end_at TEXT,
    fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (user_id, resource, document_id)
);

CREATE INDEX IF NOT EXISTS idx_oura_raw_documents_resource_day
    ON oura_raw_documents(resource, day);

CREATE INDEX IF NOT EXISTS idx_oura_raw_documents_resource_start_at
    ON oura_raw_documents(resource, start_at);

CREATE TABLE IF NOT EXISTS oura_sync_state (
    user_id TEXT NOT NULL,
    resource TEXT NOT NULL,
    next_token TEXT,
    cursor_start TEXT,
    cursor_end TEXT,
    last_success_at TEXT,
    last_error_at TEXT,
    last_error TEXT,
    PRIMARY KEY (user_id, resource)
);
