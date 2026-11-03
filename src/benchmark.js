require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');
const { createClient } = require('redis');
const { generate } = require('./generateData');
const { ingestMongo } = require('./ingestMongo');
const { ingestRedis } = require('./ingestRedis');
const { mongoQueries, redisQueries } = require('./queries');

const ITERATIONS = 200;

async function timeIt(fn, iterations) {
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) await fn(i);
  const end = process.hrtime.bigint();
  const totalMs = Number(end - start) / 1e6;
  return { totalMs, avgMs: totalMs / iterations };
}

async function run() {
  const { stops, routes, trips } = generate();

  const mongoClient = new MongoClient(process.env.MONGO_URI);
  await mongoClient.connect();
  const db = mongoClient.db();
  await ingestMongo(db, trips);

  const redisClient = createClient({ url: process.env.REDIS_URL });
  await redisClient.connect();
  await ingestRedis(redisClient, trips);

  const routeIds = routes.map((r) => r.route_id);
  const tripIds = trips.map((t) => t.trip_id);

  const results = {};

  results.tripsByRoute = {
    mongo: await timeIt((i) => mongoQueries.tripsByRoute(db, routeIds[i % routeIds.length]), ITERATIONS),
    redis: await timeIt((i) => redisQueries.tripsByRoute(redisClient, routeIds[i % routeIds.length]), ITERATIONS),
  };

  results.nextTripAfter = {
    mongo: await timeIt(
      (i) => mongoQueries.nextTripAfter(db, routeIds[i % routeIds.length], (i * 7) % (24 * 60)),
      ITERATIONS
    ),
    redis: await timeIt(
      (i) => redisQueries.nextTripAfter(redisClient, routeIds[i % routeIds.length], (i * 7) % (24 * 60)),
      ITERATIONS
    ),
  };

  results.tripDetails = {
    mongo: await timeIt((i) => mongoQueries.tripDetails(db, tripIds[i % tripIds.length]), ITERATIONS),
    redis: await timeIt((i) => redisQueries.tripDetails(redisClient, tripIds[i % tripIds.length]), ITERATIONS),
  };

  console.log(`\nBenchmark: ${ITERATIONS} iterations per query, ${trips.length} trips, ${routes.length} routes, ${stops.length} stops\n`);
  console.log('Query                 | MongoDB avg (ms) | Redis avg (ms) | Redis speedup');
  console.log('-----------------------------------------------------------------------');
  for (const [name, r] of Object.entries(results)) {
    const speedup = (r.mongo.avgMs / r.redis.avgMs).toFixed(1);
    console.log(
      `${name.padEnd(22)} | ${r.mongo.avgMs.toFixed(3).padStart(16)} | ${r.redis.avgMs.toFixed(3).padStart(14)} | ${speedup}x`
    );
  }

  const report = {
    generatedAt: new Date().toISOString(),
    datasetSize: { stops: stops.length, routes: routes.length, trips: trips.length },
    iterations: ITERATIONS,
    results: Object.fromEntries(
      Object.entries(results).map(([name, r]) => [
        name,
        { mongoAvgMs: r.mongo.avgMs, redisAvgMs: r.redis.avgMs, redisSpeedup: r.mongo.avgMs / r.redis.avgMs },
      ])
    ),
  };
  fs.writeFileSync(path.join(__dirname, '..', 'benchmark-results.json'), JSON.stringify(report, null, 2));

  await mongoClient.close();
  await redisClient.quit();
}

if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { run, timeIt };
