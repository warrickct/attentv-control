# DynamoDB Query Capabilities for `attentv-ad-plays-prod`

## Table Structure

**Primary Key:**
- Partition Key (HASH): `play_id` (String)
- Sort Key (RANGE): `timestamp` (String)

**Total Items:** 53,623 items
**Billing Mode:** PAY_PER_REQUEST (on-demand)

## Query Options

### 1. Query by Play ID (Primary Key)
**Most efficient - uses primary key directly**

```javascript
// Exact play_id match
Query: play_id = "specific-play-id"

// With timestamp range (optional)
Query: play_id = "specific-play-id" AND timestamp BETWEEN "start" AND "end"
```

**Use case:** Get specific play details

---

### 2. Query by Ad Filename (Global Secondary Index: `ad-file-index`)
**Efficient - uses GSI**

```javascript
// All plays for a specific ad file
Query: ad_filename = "1_duck_apparel_raincoat.mp4"

// With timestamp range (optional)
Query: ad_filename = "1_duck_apparel_raincoat.mp4" 
       AND timestamp BETWEEN "2025-11-01" AND "2025-11-07"
```

**Use case:** 
- Get all plays for a specific ad
- Get ad performance over time
- Filter by date range

---

### 3. Query by Device ID (Global Secondary Index: `device-index`)
**Efficient - uses GSI**

```javascript
// All plays from a specific device
Query: device_id = "attentv-edge-3-flying-duck"

// With timestamp range (optional)
Query: device_id = "attentv-edge-3-flying-duck"
       AND timestamp BETWEEN "2025-11-01" AND "2025-11-07"
```

**Use case:**
- Get all plays from a specific device
- Device performance monitoring
- Filter by date range

---

## Current Implementation

**Currently using:** `Scan` operation (reads all items, less efficient)

**Better approach:** Use `Query` with one of the above patterns

## Cost Comparison

- **Scan (current):** Reads all items, then filters → More expensive
- **Query by play_id:** Direct lookup → Cheapest
- **Query by GSI (ad_filename/device_id):** Index lookup → Efficient, slightly more than primary key
- **Query with timestamp range:** Efficient range queries → Good for time-based filtering

## Recommendations

1. **For monitoring dashboard:** Query by `device_id` or `ad_filename` with recent timestamp range
2. **For specific play:** Query by `play_id` (primary key)
3. **For aggregations:** Use Query with timestamp ranges instead of Scan

## Query Examples

### Query by device_id (using device-index GSI):
curl -X POST http://localhost:3001/api/stats \
  -H 'Content-Type: application/json' \
  -d '{
    "tableName": "attentv-ad-plays-prod",
    "partitionKey": "device_id",
    "partitionValue": "attentv-edge-3-flying-duck",
    "indexName": "device-index",
    "limit": 10
  }'

### Query by ad_filename (using ad-file-index GSI):
curl -X POST http://localhost:3001/api/stats \
  -H 'Content-Type: application/json' \
  -d '{
    "tableName": "attentv-ad-plays-prod",
    "partitionKey": "ad_filename",
    "partitionValue": "1_duck_apparel_raincoat.mp4",
    "indexName": "ad-file-index",
    "limit": 10
  }'

### Query by play_id (primary key):
curl -X POST http://localhost:3001/api/stats \
  -H 'Content-Type: application/json' \
  -d '{
    "tableName": "attentv-ad-plays-prod",
    "partitionKey": "play_id",
    "partitionValue": "9b4dc692-012d-4915-8474-52b9d9ef6ced",
    "limit": 1
  }'

### Query with timestamp range:
curl -X POST http://localhost:3001/api/stats \
  -H 'Content-Type: application/json' \
  -d '{
    "tableName": "attentv-ad-plays-prod",
    "partitionKey": "device_id",
    "partitionValue": "attentv-edge-3-flying-duck",
    "indexName": "device-index",
    "sortKey": "timestamp",
    "sortValueStart": "2025-11-01",
    "sortValueEnd": "2025-11-07",
    "limit": 100
  }'

