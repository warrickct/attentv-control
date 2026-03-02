CREATE TABLE IF NOT EXISTS model_detection_events (
    id TEXT PRIMARY KEY,
    channel INTEGER NOT NULL,
    started_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ NOT NULL,
    duration_sec DOUBLE PRECISION NOT NULL,
    is_test BOOLEAN NOT NULL DEFAULT FALSE,
    user_name TEXT NULL,
    source TEXT NOT NULL DEFAULT 'dynamodb',
    raw_payload JSONB NULL,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT model_detection_events_valid_range CHECK (ended_at > started_at),
    CONSTRAINT model_detection_events_valid_duration CHECK (duration_sec >= 0)
);

CREATE INDEX IF NOT EXISTS idx_model_detection_events_channel_started_at
    ON model_detection_events(channel, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_model_detection_events_started_at
    ON model_detection_events(started_at DESC);

CREATE TABLE IF NOT EXISTS model_performance_15min (
    channel INTEGER NOT NULL,
    bucket_start TIMESTAMPTZ NOT NULL,
    bucket_end TIMESTAMPTZ NOT NULL,
    ground_truth_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
    model_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
    overlap_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
    recall_by_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
    precision_by_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
    break_hit_rate DOUBLE PRECISION NOT NULL DEFAULT 0,
    missed_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
    false_positive_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
    average_start_latency_sec DOUBLE PRECISION NULL,
    p95_start_latency_sec DOUBLE PRECISION NULL,
    average_over_capture_tail_sec DOUBLE PRECISION NULL,
    total_ground_truth_breaks INTEGER NOT NULL DEFAULT 0,
    matched_ground_truth_breaks INTEGER NOT NULL DEFAULT 0,
    total_model_intervals INTEGER NOT NULL DEFAULT 0,
    matched_model_intervals INTEGER NOT NULL DEFAULT 0,
    total_ground_truth_recordings INTEGER NOT NULL DEFAULT 0,
    latest_truth_break_at TIMESTAMPTZ NULL,
    latest_model_interval_at TIMESTAMPTZ NULL,
    latency_sample_count INTEGER NOT NULL DEFAULT 0,
    start_latency_sum_sec DOUBLE PRECISION NOT NULL DEFAULT 0,
    over_capture_tail_sample_count INTEGER NOT NULL DEFAULT 0,
    over_capture_tail_sum_sec DOUBLE PRECISION NOT NULL DEFAULT 0,
    refreshed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (channel, bucket_start)
);

CREATE INDEX IF NOT EXISTS idx_model_performance_15min_bucket_start
    ON model_performance_15min(bucket_start DESC);

CREATE TABLE IF NOT EXISTS model_performance_hourly (
    LIKE model_performance_15min INCLUDING ALL
);

ALTER TABLE model_performance_hourly
    DROP CONSTRAINT IF EXISTS model_performance_hourly_pkey;

ALTER TABLE model_performance_hourly
    ADD CONSTRAINT model_performance_hourly_pkey PRIMARY KEY (channel, bucket_start);

CREATE INDEX IF NOT EXISTS idx_model_performance_hourly_bucket_start
    ON model_performance_hourly(bucket_start DESC);

CREATE TABLE IF NOT EXISTS model_performance_daily (
    LIKE model_performance_15min INCLUDING ALL
);

ALTER TABLE model_performance_daily
    DROP CONSTRAINT IF EXISTS model_performance_daily_pkey;

ALTER TABLE model_performance_daily
    ADD CONSTRAINT model_performance_daily_pkey PRIMARY KEY (channel, bucket_start);

CREATE INDEX IF NOT EXISTS idx_model_performance_daily_bucket_start
    ON model_performance_daily(bucket_start DESC);

CREATE TABLE IF NOT EXISTS model_performance_alerts (
    alert_id BIGSERIAL PRIMARY KEY,
    channel INTEGER NOT NULL,
    window_key TEXT NOT NULL,
    alert_code TEXT NOT NULL,
    severity TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    metric_key TEXT NOT NULL,
    current_value DOUBLE PRECISION NULL,
    baseline_value DOUBLE PRECISION NULL,
    stddev DOUBLE PRECISION NULL,
    alert_started_at TIMESTAMPTZ NOT NULL,
    alert_cleared_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_model_performance_alerts_channel_started_at
    ON model_performance_alerts(channel, alert_started_at DESC);

CREATE TABLE IF NOT EXISTS model_performance_refresh_state (
    job_name TEXT PRIMARY KEY,
    last_synced_at TIMESTAMPTZ NULL,
    metadata JSONB NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE model_detection_events IS 'Normalized ad-detection intervals mirrored from DynamoDB data_labels.';
COMMENT ON TABLE model_performance_15min IS '15-minute rollups comparing model detections against comskip truth.';
COMMENT ON TABLE model_performance_hourly IS 'Hourly rollups comparing model detections against comskip truth.';
COMMENT ON TABLE model_performance_daily IS 'Daily rollups comparing model detections against comskip truth.';
COMMENT ON TABLE model_performance_alerts IS 'Optional persisted alert states for model performance warnings.';
COMMENT ON TABLE model_performance_refresh_state IS 'Checkpoint state for sync and backfill jobs.';
