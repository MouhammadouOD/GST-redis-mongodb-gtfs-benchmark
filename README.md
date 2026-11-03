# Application-Based Benchmarking on Redis and MongoDB for Trip Planning using GTFS Data

GoMyCode checkpoint — *Application-Based Benchmarking on Redis and MongoDB for Trip Planning using GTFS Data*. A real benchmark, not a simulated one: a synthetic GTFS-like dataset is loaded into both a real MongoDB and a real Redis instance (Docker), the same three trip-planning queries are run against both, and their timings are compared.

## Folder structure

```
src/generateData.js   Deterministic (seeded) generator for GTFS-like stops/routes/trips
src/ingestMongo.js    Loads trips into MongoDB (one document per trip, stop_times embedded)
src/ingestRedis.js    Loads trips into Redis (a Hash per trip + a Sorted Set per route)
src/queries.js        The same 3 trip-planning queries implemented against both databases
src/benchmark.js       Runs the benchmark and writes benchmark-results.json
tests.js               14 correctness assertions: MongoDB and Redis must agree on every query
```

## 1. Introduction to GTFS Data

GTFS (General Transit Feed Specification) is a standard format transit agencies use to publish schedule and geographic data: stops (location, name), routes, trips (a specific run of a route), and stop_times (when a trip reaches each stop). It is used for trip planning by letting an application answer questions like "which trips serve this route", "when is the next departure after time T", and "what stops does this trip pass through, and when" — exactly the three query types benchmarked here.

## 2. Overview of Redis and MongoDB

Both are NoSQL databases, meaning they don't require a fixed relational schema or SQL joins — unlike traditional SQL databases (PostgreSQL, MySQL), which store normalized rows in tables linked by foreign keys.

- **Redis**: an in-memory key-value store. Data lives in RAM, keyed by name, as one of a few data structures (strings, hashes, sorted sets, lists, sets). No query language — access is always "by key". Optional persistence (RDB/AOF) backs the in-memory data to disk.
- **MongoDB**: a document database. Data lives in collections of JSON-like (BSON) documents, stored on disk, queried with a rich filter/sort/aggregation API, and indexed like a relational database's columns.

## 3. Benchmarking Criteria

This benchmark measures **query latency** (average time per query, in milliseconds) for the three query shapes a trip-planning app actually needs: "all trips on a route", "next trip after a given time", and "full details of one trip by id". Benchmarking matters because a database's suitability is specific to the access pattern of the application — a database that looks fast in general-purpose benchmarks can still be the wrong choice if its query planner doesn't fit how the app actually queries data. Measuring the app's real queries, not synthetic ones, is what tells you whether a choice is correct for *this* application.

## 4. Data Ingestion and Storage

- **Ingestion**: `src/generateData.js` builds a deterministic dataset (150 stops, 20 routes, 300 trips, 3–6 stop_times each) with a seeded PRNG so every run is reproducible. `ingestMongo.js` and `ingestRedis.js` each load the same `trips` array into their respective database.
- **MongoDB storage**: one document per trip, `stop_times` embedded as an array inside it — the natural MongoDB modeling choice for data that's always read together (a trip's stops are never queried independently of the trip). Indexed on `trip_id` (unique) and `(route_id, departure_time)`.
- **Redis storage**: two structures per trip:
  - a **Hash** `trip:<id>` → `{route_id, departure_time, stop_times (JSON string)}`, for O(1) point lookups by trip id.
  - a **Sorted Set** `route:<route_id>:trips`, scored by `departure_time`, so "trips on this route" and "next trip after time T" become native Redis range operations (`ZRANGE`, `ZRANGEBYSCORE`) instead of a scan.

This is the key structural difference: MongoDB stores one flexible, queryable record; Redis requires the application to pre-model each access pattern into its own key.

## 5. Query Performance (real measurements, not estimated)

Real run, 200 iterations per query, against a disposable `mongo:7` and `redis:7` Docker container, dataset of 150 stops / 20 routes / 300 trips:

| Query | MongoDB avg | Redis avg | Redis speedup |
|---|---|---|---|
| `tripsByRoute` (all trips on a route) | 0.450 ms | 0.160 ms | 2.8x |
| `nextTripAfter` (next departure after time T) | 0.263 ms | 0.107 ms | 2.5x |
| `tripDetails` (point lookup by trip id) | 0.207 ms | 0.110 ms | 1.9x |

Raw data in `benchmark-results.json`. Example queries (implemented in `src/queries.js`):
- `tripsByRoute(routeId)` → MongoDB: `find({route_id}).project({trip_id:1})`; Redis: `ZRANGE route:<id>:trips 0 -1`.
- `nextTripAfter(routeId, afterMinute)` → MongoDB: `find({route_id, departure_time:{$gte}}).sort().limit(1)`; Redis: `ZRANGEBYSCORE route:<id>:trips afterMinute +inf LIMIT 0 1`.
- `tripDetails(tripId)` → MongoDB: `findOne({trip_id})`; Redis: `HGETALL trip:<id>`.

Redis is faster on every query here, which matches the theory (in-memory vs. disk-based), though the gap is a few tenths of a millisecond at this dataset size — on a small dataset like this, both are fast enough that the difference wouldn't be user-perceptible; the gap would widen with a much larger dataset or heavier concurrent load.

## 6. Scalability and Efficiency

- **Redis** scales by adding more RAM (vertically) or by sharding keys across a Redis Cluster (horizontally); replication (master-replica) adds read scalability and redundancy. The practical ceiling is memory: a GTFS dataset that is bigger than available RAM cannot be fully cached in Redis without re-architecting (e.g., caching only hot routes/trips).
- **MongoDB** scales natively through sharding (partitioning collections across servers by a shard key) and replica sets, and because it is disk-based, dataset size isn't bounded by RAM the way Redis's is.
- **Recommendation for a large-scale trip-planning app**: use both, the way `GST-distributed-kv-store` and the lesson's own caching-layer example demonstrate. MongoDB as the system of record for the full GTFS dataset (all stops/routes/trips/schedules, which can be large and needs flexible querying), and Redis as a cache in front of it for the hot path — upcoming departures, frequently viewed routes — exactly the cache-aside pattern from this module's lesson. This gives MongoDB's scalability for the full dataset and Redis's latency for the queries that actually need to be fast.

## 7. Practical Application: a simple trip-planning app design

**Design** (and this is literally what `src/` implements, minus the HTTP layer):

1. **Storage**: MongoDB holds the canonical GTFS data (`stops`, `routes`, `trips` collections, trips embedding `stop_times`) — loaded once from a GTFS feed via `ingestMongo.js`'s pattern.
2. **Cache**: Redis holds the same trips, keyed as `trip:<id>` (Hash) and `route:<id>:trips` (Sorted Set by departure time) — populated from MongoDB on startup or lazily on first access (cache-aside), via `ingestRedis.js`'s pattern.
3. **API layer** (not built here, but the natural next step — the same shape as `GST-checkpoint-rest-api`): an Express server with endpoints like `GET /routes/:id/trips` and `GET /routes/:id/next-trip?after=`, each checking Redis first and falling back to MongoDB on a cache miss, then populating Redis for next time.
4. **Invalidation**: since GTFS schedules change infrequently (new feed published periodically, not per-request), a simple TTL (e.g., re-ingest daily) is enough — no need for write-through invalidation on every update.

## 8. Conclusion

**Redis** advantages: much lower query latency (it's in-memory), purpose-built data structures (sorted sets fit "next departure" perfectly), simple horizontal scaling via clustering. Disadvantages: no rich query language (every access pattern must be pre-modeled into a key), dataset size is bounded by RAM, weaker durability guarantees than a disk-based database.

**MongoDB** advantages: flexible querying and indexing without pre-modeling every access pattern, disk-based so dataset size isn't RAM-bound, ACID-compliant transactions, built-in sharding for very large datasets. Disadvantages: slower than Redis for the same query (confirmed above), more operational overhead for the same throughput.

**Recommendation**: for a real GTFS trip-planning application I would not choose one over the other — I'd use MongoDB as the source of truth (it already comfortably handles the full dataset and any query shape not anticipated in advance) and Redis as a cache for the specific, high-frequency trip-planning queries benchmarked here (trips by route, next departure, trip details), matching the 1.9x–2.8x speedup measured above. For future GTFS projects, that hybrid is the default I'd reach for, not a single-database choice.

## How to run

```bash
npm install
cp .env.example .env   # set MONGO_URI and REDIS_URL

# real, disposable Docker instances (ports chosen to avoid clashing with
# other running containers; adjust if needed):
docker run -d --name gst-gtfs-mongo -p 27020:27017 mongo:7
docker run -d --name gst-gtfs-redis -p 6381:6379 redis:7

node tests.js       # 14 correctness assertions, MongoDB vs Redis agreement
node src/benchmark.js  # real timing comparison -> benchmark-results.json

docker rm -f gst-gtfs-mongo gst-gtfs-redis
```

## Results — real execution (verified, not simulated)

Run on 2026-11-03 against real `mongo:7` / `redis:7` Docker containers:

```
$ node tests.js
...
14/14 tests passed.
```

**Mutation test** (proving the suite actually discriminates correct from broken code): changed `ingestRedis.js` to score every Sorted Set entry `0` instead of the trip's real `departure_time`, which breaks `ZRANGEBYSCORE`'s ability to find "next trip after time T". Re-ran `tests.js` — the `Redis nextTripAfter matches the brute-force expected trip` assertion failed as expected. Reverted the change and confirmed `14/14 tests passed.` again.

`npm audit` → 0 vulnerabilities.
