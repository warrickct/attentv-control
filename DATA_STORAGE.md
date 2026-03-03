# Data Storage Split

## Goal

Use Cloud SQL for anything we need to filter, search, compare, or aggregate over time.
Keep DynamoDB only for source writes and small operational lookups that do not need analytics-style querying.

## Cloud SQL

These are the default query paths for the dashboard now:

- `model_detection_events`
  - mirrored from DynamoDB `data_labels`
  - indexed by `channel` and `started_at`
  - used for model-performance overview, trends, breakdowns, detail views, and the `Data Labels` tab
- `ad_play_events`
  - mirrored from DynamoDB `attentv-ad-plays-prod`
  - indexed by `played_at`, `device_id + played_at`, and `ad_filename + played_at`
  - used for device summaries, time series, leaderboards, comparisons, and aggregate ad-play views

Optional / legacy SQL rollups:

- `model_performance_15min`
- `model_performance_hourly`
- `model_performance_daily`
- `ad_play_hourly`

These still exist for repair or future optimization, but the live dashboard now prefers raw mirrored SQL tables by default because freshness matters more than precomputed speed here.

## DynamoDB

These stay in DynamoDB for now:

- `data_labels`
  - write/source table
  - mirrored continuously into Cloud SQL
- `attentv-ad-plays-prod`
  - write/source table
  - mirrored continuously into Cloud SQL
- `attentv-labelling-users`
  - tiny auth lookup table
  - point-read only, no heavy filtering/querying requirement
- `channel_updates`
  - small snapshot/config-style table
  - not used for analytics queries in this dashboard

Not currently provisioned:

- `attentv-quick-question-responses`

## How Mirroring Works

The Railway backend now runs a background SQL mirror worker:

- `data_labels`
  - incremental DynamoDB `Query` by `channel + startTime`
  - recent-day replay to catch late writes
- `attentv-ad-plays-prod`
  - incremental DynamoDB `Query` on the `device-index`
  - recent-hour replay to catch late writes

That means:

- no manual cron is required for normal live freshness
- the dashboard reads from SQL by default
- manual backfill scripts are now repair/bootstrap tools, not the normal path

## Operational Notes

- `SQL_REPLICATION_ENABLED=false` disables the background mirror worker.
- `MODEL_PERFORMANCE_PREFER_AGGREGATES=true` opts model-performance endpoints back into SQL rollups.
- `AD_PLAY_PREFER_HOURLY_ROLLUPS=true` opts ad-play endpoints back into `ad_play_hourly`.
- `npm run sql-mirror:sync` runs one replication cycle manually.
