require('dotenv').config();
const assert = require('assert');
const { MongoClient } = require('mongodb');
const { createClient } = require('redis');
const { generate } = require('./src/generateData');
const { ingestMongo } = require('./src/ingestMongo');
const { ingestRedis } = require('./src/ingestRedis');
const { mongoQueries, redisQueries } = require('./src/queries');

const TOTAL_TESTS = 14;
let passed = 0;

function check(name, condition) {
  assert.ok(condition, name);
  passed++;
  console.log(`PASS: ${name}`);
}

async function run() {
  const { stops, routes, trips } = generate();

  const mongoClient = new MongoClient(process.env.MONGO_URI);
  await mongoClient.connect();
  const db = mongoClient.db();
  const collection = await ingestMongo(db, trips);

  const redisClient = createClient({ url: process.env.REDIS_URL });
  await redisClient.connect();
  await ingestRedis(redisClient, trips);

  // --- Ingestion correctness ---
  check('generated dataset has the expected sizes', stops.length === 150 && routes.length === 20 && trips.length === 300);

  const mongoCount = await collection.countDocuments();
  check('MongoDB received every generated trip', mongoCount === trips.length);

  let redisTripCount = 0;
  for (const trip of trips) {
    if (await redisClient.exists(`trip:${trip.trip_id}`)) redisTripCount++;
  }
  check('Redis received every generated trip as a hash', redisTripCount === trips.length);

  // --- Point lookup correctness (tripDetails) ---
  const sampleTrip = trips[0];
  const mongoDetails = await mongoQueries.tripDetails(db, sampleTrip.trip_id);
  const redisDetails = await redisQueries.tripDetails(redisClient, sampleTrip.trip_id);
  check('MongoDB tripDetails returns the right route_id', mongoDetails.route_id === sampleTrip.route_id);
  check('Redis tripDetails returns the right route_id', redisDetails.route_id === sampleTrip.route_id);
  check(
    'MongoDB and Redis agree on departure_time for the same trip',
    mongoDetails.departure_time === redisDetails.departure_time
  );
  check(
    'MongoDB and Redis agree on stop_times for the same trip',
    JSON.stringify(mongoDetails.stop_times) === JSON.stringify(redisDetails.stop_times)
  );

  const missing = await mongoQueries.tripDetails(db, 'no_such_trip');
  check('MongoDB tripDetails returns null for an unknown trip', missing === null);
  const missingRedis = await redisQueries.tripDetails(redisClient, 'no_such_trip');
  check('Redis tripDetails returns null for an unknown trip', missingRedis === null);

  // --- tripsByRoute correctness: MongoDB and Redis must agree exactly ---
  const sampleRoute = routes[0].route_id;
  const expectedTripIds = trips.filter((t) => t.route_id === sampleRoute).map((t) => t.trip_id);
  const mongoTripIds = await mongoQueries.tripsByRoute(db, sampleRoute);
  const redisTripIds = await redisQueries.tripsByRoute(redisClient, sampleRoute);
  check(
    'MongoDB tripsByRoute returns exactly the trips generated for that route',
    new Set(mongoTripIds).size === expectedTripIds.length &&
      expectedTripIds.every((id) => mongoTripIds.includes(id))
  );
  check(
    'Redis tripsByRoute returns exactly the trips generated for that route',
    new Set(redisTripIds).size === expectedTripIds.length &&
      expectedTripIds.every((id) => redisTripIds.includes(id))
  );

  // --- nextTripAfter correctness: both databases must agree with a
  // brute-force computation over the in-memory dataset ---
  const tripsOnRoute = trips.filter((t) => t.route_id === sampleRoute).sort((a, b) => a.departure_time - b.departure_time);
  const afterMinute = tripsOnRoute[Math.floor(tripsOnRoute.length / 2)].departure_time;
  const expectedNext = tripsOnRoute.find((t) => t.departure_time >= afterMinute).trip_id;

  const mongoNext = await mongoQueries.nextTripAfter(db, sampleRoute, afterMinute);
  const redisNext = await redisQueries.nextTripAfter(redisClient, sampleRoute, afterMinute);
  check('MongoDB nextTripAfter matches the brute-force expected trip', mongoNext === expectedNext);
  check('Redis nextTripAfter matches the brute-force expected trip', redisNext === expectedNext);

  const farFuture = 24 * 60 + 1000;
  const mongoNone = await mongoQueries.nextTripAfter(db, sampleRoute, farFuture);
  check('MongoDB nextTripAfter returns null past the last departure', mongoNone === null);

  await mongoClient.close();
  await redisClient.quit();

  assert.strictEqual(passed, TOTAL_TESTS, `expected ${TOTAL_TESTS} passing tests, got ${passed}`);
  console.log(`\n${passed}/${TOTAL_TESTS} tests passed.`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
