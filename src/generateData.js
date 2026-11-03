const fs = require('fs');
const path = require('path');

// Deterministic PRNG (mulberry32) so the generated dataset is reproducible
// across runs instead of relying on Math.random().
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(42);
const NUM_STOPS = 150;
const NUM_ROUTES = 20;
const NUM_TRIPS = 300;

function generate() {
  const stops = Array.from({ length: NUM_STOPS }, (_, i) => ({
    stop_id: `stop_${i}`,
    stop_name: `Stop ${i}`,
    lat: 14.6 + rand() * 0.3, // roughly Dakar-area coordinates, for realism
    lon: -17.5 + rand() * 0.3,
  }));

  const routes = Array.from({ length: NUM_ROUTES }, (_, i) => ({
    route_id: `route_${i}`,
    route_name: `Route ${i}`,
  }));

  const trips = Array.from({ length: NUM_TRIPS }, (_, i) => {
    const route = routes[Math.floor(rand() * routes.length)];
    const stopCount = 3 + Math.floor(rand() * 4); // 3..6 stops per trip
    const departureMinute = Math.floor(rand() * 24 * 60); // minutes since midnight
    const stop_times = [];
    let t = departureMinute;
    for (let s = 0; s < stopCount; s++) {
      const stop = stops[Math.floor(rand() * stops.length)];
      stop_times.push({ stop_id: stop.stop_id, arrival_time: t });
      t += 5 + Math.floor(rand() * 10); // 5-15 minutes between stops
    }
    return {
      trip_id: `trip_${i}`,
      route_id: route.route_id,
      departure_time: departureMinute,
      stop_times,
    };
  });

  return { stops, routes, trips };
}

if (require.main === module) {
  const data = generate();
  const outPath = path.join(__dirname, '..', 'data.json');
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
  console.log(
    `Generated ${data.stops.length} stops, ${data.routes.length} routes, ${data.trips.length} trips -> ${outPath}`
  );
}

module.exports = { generate };
