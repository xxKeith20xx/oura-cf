-- 1. DAILY SUMMARIES: All Scores & Contributors (Flattened)
CREATE TABLE IF NOT EXISTS daily_summaries (
    day DATE PRIMARY KEY,
    -- Readiness
    readiness_score INTEGER,
    readiness_activity_balance INTEGER,
    readiness_body_temperature INTEGER,
    readiness_hrv_balance INTEGER,
    readiness_previous_day_activity INTEGER,
    readiness_previous_night_sleep INTEGER,
    readiness_recovery_index INTEGER,
    readiness_resting_heart_rate INTEGER,
    readiness_sleep_balance INTEGER,
    -- Sleep
    sleep_score INTEGER,
    sleep_deep_sleep INTEGER,
    sleep_efficiency INTEGER,
    sleep_latency INTEGER,
    sleep_rem_sleep INTEGER,
    sleep_restfulness INTEGER,
    sleep_timing INTEGER,
    sleep_total_sleep INTEGER,
    -- Activity
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
    -- New 2024/2025 Health Metrics
    stress_index INTEGER,
    resilience_level TEXT,
    resilience_contributors_sleep INTEGER,
    resilience_contributors_stress INTEGER,
    spo2_percentage REAL,
    spo2_breathing_disturbance_index INTEGER,
    cv_age_offset INTEGER, -- Cardiovascular Age
    vo2_max REAL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2. HIGH-RES HEART RATE: Every 5-minute interval
CREATE TABLE IF NOT EXISTS heart_rate_samples (
    timestamp DATETIME PRIMARY KEY,
    bpm INTEGER,
    source TEXT -- 'awake', 'rest', 'sleep', 'session', 'workout'
);

-- 3. SLEEP SESSIONS: The Hypnogram & Vital Averages
CREATE TABLE IF NOT EXISTS sleep_episodes (
    id TEXT PRIMARY KEY,
    day DATE,
    start_datetime DATETIME,
    end_datetime DATETIME,
    type TEXT, -- 'long_sleep' or 'nap'
    heart_rate_avg REAL,
    heart_rate_lowest REAL,
    hrv_avg REAL,
    breath_avg REAL,
    temperature_deviation REAL,
    -- Stages (seconds)
    deep_duration INTEGER,
    rem_duration INTEGER,
    light_duration INTEGER,
    awake_duration INTEGER
);

-- 4. LOGS: Workouts & Meditation Sessions
CREATE TABLE IF NOT EXISTS activity_logs (
    id TEXT PRIMARY KEY,
    type TEXT, -- 'workout' or 'session'
    start_datetime DATETIME,
    end_datetime DATETIME,
    activity_label TEXT,
    intensity TEXT,
    calories REAL,
    distance REAL,
    hr_avg REAL,
    mood TEXT -- For meditation sessions
);

-- 5. TAGS & CONTEXT: The "Why"
CREATE TABLE IF NOT EXISTS user_tags (
    id TEXT PRIMARY KEY,
    day DATE,
    tag_type TEXT,
    comment TEXT
);
