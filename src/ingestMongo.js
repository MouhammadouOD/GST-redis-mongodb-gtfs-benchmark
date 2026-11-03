// Loads the generated GTFS-like trips into MongoDB as one document per trip,
// with stop_times embedded (the natural MongoDB modeling choice for data
// that is always read together).
async function ingestMongo(db, trips) {
  const collection = db.collection('trips');
  await collection.deleteMany({});
  if (trips.length > 0) await collection.insertMany(trips);
  await collection.createIndex({ trip_id: 1 }, { unique: true });
  await collection.createIndex({ route_id: 1, departure_time: 1 });
  return collection;
}

module.exports = { ingestMongo };
