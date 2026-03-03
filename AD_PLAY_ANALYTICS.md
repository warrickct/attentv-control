# Ad Play Analytics

## Overview

The legacy dashboard endpoints under `/api/stats/aggregate/*`, `/api/stats/ads/leaderboard`,
`/api/stats/devices/comparison`, and `/api/stats/device/:deviceId/ads`
now read from Cloud SQL instead of aggregating raw DynamoDB data on request.

The live backend now keeps `attentv-ad-plays-prod` mirrored into Cloud SQL continuously.
The dashboard prefers the raw mirrored SQL table by default, which keeps reads fresh without
depending on a batch rollup refresh job.

## Data Flow

1. Source: DynamoDB `attentv-ad-plays-prod`
2. Normalized SQL table: `ad_play_events`
3. UTC hourly rollups: `ad_play_hourly`
4. UI/API reads:
   - summary, leaderboard, device comparison, device ad breakdown:
     - prefer `ad_play_events`
     - optionally use `ad_play_hourly` only when `AD_PLAY_PREFER_HOURLY_ROLLUPS=true`
   - hourly and day-of-week charts:
     - read from `ad_play_events` by default
     - optionally use `ad_play_hourly` when explicitly enabled

## Schema

Defined in [sql_cloud/ad_play_analytics_schema.sql](/Users/g/Desktop/desktop/projects/AttenTv/attentv-control/sql_cloud/ad_play_analytics_schema.sql).

Tables:

- `ad_play_events`
- `ad_play_hourly`
- `ad_play_analytics_refresh_state`

## Backfill

Normal live operation does not require a scheduled backfill anymore. The Railway backend runs
the SQL mirror worker continuously.

For one-off repair/bootstrap:

```bash
npm run sql-mirror:sync
```

Legacy backfill and rollup rebuild commands still exist:

```bash
npm run ad-play-analytics:backfill -- --mode all
```

Modes:

- `sync`: mirror raw DynamoDB rows into `ad_play_events`
- `aggregate`: rebuild `ad_play_hourly`
- `all`: run both steps

Optional range for the aggregate step:

```bash
npm run ad-play-analytics:backfill -- --mode aggregate --start 2026-03-01 --end 2026-03-02
```

If `--start/--end` are omitted, the script rebuilds the full range found in `ad_play_events`.

## Runtime Requirements

Uses the same env-backed Cloud SQL and AWS config already used elsewhere in this repo:

- `INSTANCE_CONNECTION_NAME`
- `DB_NAME`
- `DB_USER`
- `GOOGLE_SQL_PASS`
- `GOOGLE_APPLICATION_CREDENTIALS` or `GOOGLE_APPLICATION_CREDENTIALS_JSON`
- `CLOUD_SQL_IP_TYPE`
- `MY_AWS_ACCESS_KEY_ID`
- `MY_AWS_SECRET_ACCESS_KEY`
- `MY_AWS_REGION`
- `AD_PLAYS_TABLE`

## Recommendation

Use the continuous SQL mirror for day-to-day operation.
Keep the backfill command only for historical repair or a one-time rebuild.
