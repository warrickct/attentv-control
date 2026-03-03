CREATE TABLE IF NOT EXISTS ad_play_events (
    play_id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    ad_filename TEXT NOT NULL,
    played_at TIMESTAMPTZ NOT NULL,
    play_duration DOUBLE PRECISION NOT NULL DEFAULT 0,
    play_start_time TIMESTAMPTZ NULL,
    play_end_time TIMESTAMPTZ NULL,
    environment TEXT NULL,
    play_status TEXT NULL,
    bug_detected BOOLEAN NULL,
    switch_type TEXT NULL,
    metadata JSONB NULL,
    raw_payload JSONB NULL,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ad_play_events_duration_non_negative CHECK (play_duration >= 0)
);

CREATE INDEX IF NOT EXISTS idx_ad_play_events_played_at
    ON ad_play_events(played_at DESC);

CREATE INDEX IF NOT EXISTS idx_ad_play_events_device_played_at
    ON ad_play_events(device_id, played_at DESC);

CREATE INDEX IF NOT EXISTS idx_ad_play_events_ad_played_at
    ON ad_play_events(ad_filename, played_at DESC);

CREATE TABLE IF NOT EXISTS ad_play_hourly (
    bucket_start TIMESTAMPTZ NOT NULL,
    bucket_end TIMESTAMPTZ NOT NULL,
    device_id TEXT NOT NULL,
    ad_filename TEXT NOT NULL,
    play_count INTEGER NOT NULL DEFAULT 0,
    total_duration DOUBLE PRECISION NOT NULL DEFAULT 0,
    first_play_at TIMESTAMPTZ NULL,
    last_play_at TIMESTAMPTZ NULL,
    refreshed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (bucket_start, device_id, ad_filename)
);

CREATE INDEX IF NOT EXISTS idx_ad_play_hourly_bucket_start
    ON ad_play_hourly(bucket_start DESC);

CREATE INDEX IF NOT EXISTS idx_ad_play_hourly_device_bucket
    ON ad_play_hourly(device_id, bucket_start DESC);

CREATE INDEX IF NOT EXISTS idx_ad_play_hourly_ad_bucket
    ON ad_play_hourly(ad_filename, bucket_start DESC);

CREATE TABLE IF NOT EXISTS ad_play_analytics_refresh_state (
    job_name TEXT PRIMARY KEY,
    last_synced_at TIMESTAMPTZ NULL,
    metadata JSONB NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE ad_play_events IS 'Normalized ad-play events mirrored from DynamoDB attentv-ad-plays-prod.';
COMMENT ON TABLE ad_play_hourly IS 'UTC-hour rollups by device and ad filename for dashboard analytics.';
COMMENT ON TABLE ad_play_analytics_refresh_state IS 'Checkpoint state for ad-play sync and aggregate jobs.';
