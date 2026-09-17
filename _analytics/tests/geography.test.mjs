import test from "node:test";
import assert from "node:assert/strict";
import { estimatedCounty } from "../src/geography.mjs";
import counties from "../src/us-counties.json" with { type: "json" };

const stanford = { country: "US", city: "Stanford", regionCode: "CA", latitude: "37.4275", longitude: "-122.1697" };
const unknown = { county: "", county_fips: "" };

test("Census lookup resolves counties and county equivalents, including current Connecticut regions", () => {
  for (const [city, regionCode, latitude, longitude, fips] of [
    ["Stanford", "CA", 37.4275, -122.1697, "06085"],
    ["San Francisco", "CA", 37.7749, -122.4194, "06075"],
    ["New York", "NY", 40.7484, -73.9857, "36061"],
    ["Cambridge", "MA", 42.3736, -71.1097, "25017"],
    ["Washington", "DC", 38.9072, -77.0369, "11001"],
    ["Anchorage", "AK", 61.2181, -149.9003, "02020"],
    ["Honolulu", "HI", 21.3099, -157.8581, "15003"],
    ["Hartford", "CT", 41.7658, -72.6734, "09110"],
  ]) assert.equal(estimatedCounty({ country: "US", city, regionCode, latitude, longitude }).county_fips, fips, city);
  assert.equal(new Set(counties.features.map(f => f.properties.code)).size, counties.features.length);
});

test("missing, invalid, conflicting, non-US, and offshore locations remain unknown", () => {
  for (const change of [{ country: "GB" }, { city: "" }, { regionCode: "" }, { regionCode: "NY" },
    { latitude: null }, { latitude: "" }, { longitude: " " }, { latitude: "abc" }, { latitude: 91 },
    { longitude: 181 }, { latitude: 0, longitude: 0 }, { latitude: 36, longitude: -125 }]) {
    assert.deepEqual(estimatedCounty({ ...stanford, ...change }), unknown);
  }
  assert.deepEqual(estimatedCounty(), unknown);
  assert.deepEqual(Object.keys(estimatedCounty(stanford)).sort(), ["county", "county_fips"]);
});
