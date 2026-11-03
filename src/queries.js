// The same three trip-planning queries, implemented once against MongoDB
// and once against Redis, so the benchmark compares like for like.

const mongoQueries = {
  async tripsByRoute(db, routeId) {
    const docs = await db
      .collection('trips')
      .find({ route_id: routeId })
      .project({ trip_id: 1, _id: 0 })
      .toArray();
    return docs.map((d) => d.trip_id);
  },

  async nextTripAfter(db, routeId, afterMinute) {
    const doc = await db
      .collection('trips')
      .find({ route_id: routeId, departure_time: { $gte: afterMinute } })
      .sort({ departure_time: 1 })
      .limit(1)
      .next();
    return doc ? doc.trip_id : null;
  },

  async tripDetails(db, tripId) {
    const doc = await db.collection('trips').findOne({ trip_id: tripId });
    if (!doc) return null;
    return { route_id: doc.route_id, departure_time: doc.departure_time, stop_times: doc.stop_times };
  },
};

const redisQueries = {
  async tripsByRoute(client, routeId) {
    return client.zRange(`route:${routeId}:trips`, 0, -1);
  },

  async nextTripAfter(client, routeId, afterMinute) {
    const result = await client.zRangeByScore(`route:${routeId}:trips`, afterMinute, '+inf', {
      LIMIT: { offset: 0, count: 1 },
    });
    return result.length > 0 ? result[0] : null;
  },

  async tripDetails(client, tripId) {
    const hash = await client.hGetAll(`trip:${tripId}`);
    if (!hash || Object.keys(hash).length === 0) return null;
    return {
      route_id: hash.route_id,
      departure_time: Number(hash.departure_time),
      stop_times: JSON.parse(hash.stop_times),
    };
  },
};

module.exports = { mongoQueries, redisQueries };
