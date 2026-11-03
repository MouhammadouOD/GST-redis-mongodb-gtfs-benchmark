// Loads the generated GTFS-like trips into Redis using two structures:
// - a Hash per trip (trip:<id>) for fast point lookups by trip_id
// - a Sorted Set per route (route:<id>:trips), scored by departure_time, so
//   "trips on this route" and "next trip after time T" are native Redis
//   operations instead of application-side filtering.
async function ingestRedis(client, trips) {
  await client.flushDb();
  const multi = client.multi();
  for (const trip of trips) {
    multi.hSet(`trip:${trip.trip_id}`, {
      route_id: trip.route_id,
      departure_time: String(trip.departure_time),
      stop_times: JSON.stringify(trip.stop_times),
    });
    multi.zAdd(`route:${trip.route_id}:trips`, {
      score: trip.departure_time,
      value: trip.trip_id,
    });
  }
  await multi.exec();
}

module.exports = { ingestRedis };
