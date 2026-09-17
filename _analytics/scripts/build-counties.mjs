// Convert the Census 2025 county 1:5m shapefile to the shared lookup/map asset.
import { read } from "shapefile";
import { writeFile } from "node:fs/promises";

function coordinates(value) {
  return typeof value === "number" ? Math.round(value * 1e5) / 1e5 : value.map(coordinates);
}

const source = process.argv[2];
if (!source) throw new Error("Usage: node scripts/build-counties.mjs path/to/cb_2025_us_county_5m.shp");
const collection = await read(source, undefined, { encoding: "utf-8" });
const features = collection.features.map(feature => {
  const p = feature.properties;
  const geometry = { ...feature.geometry, coordinates: coordinates(feature.geometry.coordinates) };
  const points = geometry.coordinates.flat(geometry.type === "MultiPolygon" ? 2 : 1);
  const bbox = points.reduce((b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)], [180, 90, -180, -90]);
  return { type: "Feature", properties: { code: p.GEOID, name: p.NAMELSAD, state: p.STUSPS }, bbox, geometry };
}).sort((a, b) => a.properties.code.localeCompare(b.properties.code));
await writeFile(new URL("../src/us-counties.json", import.meta.url), JSON.stringify({ type: "FeatureCollection", features }) + "\n");
console.log(`Generated ${features.length} counties and county equivalents.`);
