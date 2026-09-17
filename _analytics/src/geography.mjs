import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import counties from "./us-counties.json" with { type: "json" };

const byState = new Map();
for (const feature of counties.features) {
  const state = feature.properties.state;
  if (!byState.has(state)) byState.set(state, []);
  byState.get(state).push(feature);
}

// Coordinates exist only during this lookup. Never infer a county from a state
// centroid, nearest polygon, submitted browser payload, or earlier visits.
export function estimatedCounty(cf = {}) {
  if (!["US", "PR"].includes(cf.country) || !cf.city || !cf.regionCode) return { county: "", county_fips: "" };
  if (cf.latitude == null || cf.longitude == null || String(cf.latitude).trim() === "" || String(cf.longitude).trim() === "") return { county: "", county_fips: "" };
  const lat = Number(cf.latitude), lon = Number(cf.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return { county: "", county_fips: "" };
  const matches = (byState.get(cf.country === "PR" ? "PR" : cf.regionCode) || []).filter(feature => booleanPointInPolygon([lon, lat], feature, { ignoreBoundary: true }));
  return matches.length === 1 ? { county: matches[0].properties.name, county_fips: matches[0].properties.code } : { county: "", county_fips: "" };
}
