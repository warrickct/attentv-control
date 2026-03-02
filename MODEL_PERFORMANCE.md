# Model Performance Dashboard

## Overview

The `Model Performance` tab is part of the existing dashboard shell in `src/App.tsx`.
It compares ad-detection model intervals against `comskip_ground_truth_*` truth breaks and renders:

- short-term KPI windows for `15m`, `1h`, and `24h`
- long-range trend charts for `7d`, `30d`, `90d`, or a custom date range
- per-channel breakdown with sparkline and warning state
- per-channel day drilldown with interval timeline and per-break comparison table

All browser reads go through backend endpoints in `server/modelPerformance.ts`.

## Data Flow

1. Truth source: Cloud SQL tables `comskip_ground_truth_recordings` and `comskip_ground_truth_breaks`
2. Model source: DynamoDB `data_labels`
3. Normalization target: Cloud SQL `model_detection_events`
4. Aggregate targets:
   - `model_performance_15min`
   - `model_performance_hourly`
   - `model_performance_daily`
5. UI read path:
   - prefer aggregate SQL tables for long-range queries
   - fall back to raw truth + normalized/raw model interval comparison when aggregates are unavailable

## Credentials

The local development server and backfill script now load `.env.local` first, then `.env`.
This repo already ignores both files in `.gitignore`.

### Google SQL

Supported environment variables:

- `INSTANCE_CONNECTION_NAME`
- `DB_NAME`
- `DB_USER`
- `GOOGLE_SQL_PASS`
- `GOOGLE_APPLICATION_CREDENTIALS`
- `GOOGLE_APPLICATION_CREDENTIALS_JSON`
- `GOOGLE_SERVICE_ACCOUNT_KEY_JSON`
- `CLOUD_SQL_IP_TYPE`

If `INSTANCE_CONNECTION_NAME` is set, the backend uses the Cloud SQL Node connector.
Otherwise it falls back to `DATABASE_URL` or direct `PG*`/`MODEL_PERFORMANCE_DB_*` Postgres settings.

Important for Netlify:

- local development can work with Application Default Credentials on the machine
- Netlify does not have local ADC, so production needs either:
  - `GOOGLE_APPLICATION_CREDENTIALS_JSON` with a service-account JSON payload that has Cloud SQL Client access, or
  - direct Postgres host/port credentials instead of the Cloud SQL connector

### AWS

Supported environment variables:

- `MY_AWS_ACCESS_KEY_ID`
- `MY_AWS_SECRET_ACCESS_KEY`
- `MY_AWS_SESSION_TOKEN`
- `MY_AWS_REGION`
- standard `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`
- `AWS_PROFILE` fallback

### Login / Session

The dashboard login now mirrors `attentv_labeller`:

- `DYNAMO_USERS_TABLE`
- `SESSION_SECRET`

The backend reads users from DynamoDB by `username` and compares the stored password, then sets a signed HTTP-only session cookie.

The server and backfill job prefer explicit environment credentials and only fall back to the local AWS profile when no env credentials are configured.

## Metrics

- `recall_by_seconds = overlap_seconds / ground_truth_seconds`
- `precision_by_seconds = overlap_seconds / model_seconds`
- `break_hit_rate = matched_ground_truth_breaks / total_ground_truth_breaks`
- `missed_seconds = ground_truth_seconds - overlap_seconds`
- `false_positive_seconds = model_seconds - overlap_seconds`
- `average_start_latency_sec`: first matched model interval start minus truth break start
- `p95_start_latency_sec`: p95 of per-break start latency
- `average_over_capture_tail_sec`: matched model tail beyond truth end

Timezone handling defaults to `Australia/Sydney`. Naive DynamoDB timestamps such as `2025-10-23T17:51:49.183814` are treated as local Sydney time.

## Alert Rules

Alerts are computed on read in `shared/modelPerformance.ts`.

- recall warning: recent recall drops by `15pp` or more vs baseline, or falls `2σ` below the trailing `30d` average
- recall critical: recent recall drops by `25pp` or more, or falls `3σ` below baseline
- precision warning/critical: same thresholds as recall
- break hit rate warning/critical: same thresholds as recall
- model-only seconds warning: more than `2x` trailing average
- model-only seconds critical: more than `3x` trailing average
- stale / missing model ingestion:
  - no recent detections despite truth breaks
  - latest model interval older than the freshness threshold

Alerts only fire when the sample size is meaningful:

- at least `30` ground-truth seconds, or
- at least `2` ground-truth breaks

## Backfill And Refresh

1. Apply the schema:

```bash
psql "$DATABASE_URL" -f sql_cloud/model_performance_schema.sql
```

2. Sync normalized detections from DynamoDB into SQL and backfill aggregates:

```bash
npm run model-performance:backfill -- --mode all --start 2025-10-01 --end 2025-10-31
```

3. Schedule recurring jobs:

- every `1-5m`: `npm run model-performance:backfill -- --mode sync --start <today> --end <today>`
- hourly: `npm run model-performance:backfill -- --mode aggregate --start <today> --end <today>`
- daily backfill: rerun the aggregate job for the previous 1-3 days

The backfill script lives at `scripts/backfill-model-performance.ts`. It:

- applies `sql_cloud/model_performance_schema.sql`
- syncs `data_labels` into `model_detection_events`
- recomputes `15m`, `hourly`, and `daily` rollups per channel and day

## Testing

Run:

```bash
npm test
npm run build
```

Current automated coverage includes:

- interval merging
- clipping and overlap math
- timezone parsing
- DST-aware day windows
- alert threshold logic
- an integration-style truth/model interval comparison path
