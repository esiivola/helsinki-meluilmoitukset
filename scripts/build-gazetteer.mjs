// Rebuilds data/gazetteer.json from the City of Helsinki WFS registers.
// Run monthly; the result is committed and consumed only by the collector,
// never shipped to the browser.

import { mkdir, writeFile } from 'node:fs/promises';
import { fetchJson } from './lib/fetch-json.mjs';

const WFS = 'https://kartta.hel.fi/ws/geoserver/avoindata/wfs';
const OUTPUT = new URL('../data/gazetteer.json', import.meta.url);

function wfsUrl(layer, count, properties) {
  const query = new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'GetFeature',
    typeName: `avoindata:${layer}`,
    outputFormat: 'application/json',
    srsName: 'EPSG:4326',
    count: String(count),
  });
  if (properties) query.set('propertyName', properties);
  return `${WFS}?${query}`;
}

function round(value) {
  return Math.round(value * 1e6) / 1e6;
}

function requireFeatures(collection, minimum, source) {
  const features = collection?.features;
  if (!Array.isArray(features) || features.length < minimum) {
    throw new Error(`${source} returned ${features?.length ?? 0} features, expected at least ${minimum}`);
  }
  return features;
}

// Mean of the largest ring is close enough for a district label anchor.
function polygonCentre(geometry) {
  if (!geometry) return null;
  const rings = geometry.type === 'Polygon'
    ? geometry.coordinates
    : geometry.coordinates.map((polygon) => polygon[0]);
  const ring = rings.reduce((longest, candidate) => (candidate.length > longest.length ? candidate : longest), []);
  if (!ring.length) return null;
  const lat = ring.reduce((sum, point) => sum + point[1], 0) / ring.length;
  const lon = ring.reduce((sum, point) => sum + point[0], 0) / ring.length;
  return [round(lat), round(lon)];
}

async function main() {
  const [addresses, names, districts, subDistricts] = await Promise.all([
    fetchJson(wfsUrl('Helsinki_osoiteluettelo', 80000, 'katunimi,gatan,osoitenumero,osoitekirjain,geom'), 120000),
    fetchJson(wfsUrl('Helsinki_nimisto', 12000), 90000),
    fetchJson(wfsUrl('Kaupunginosajako', 200), 90000),
    fetchJson(wfsUrl('Piirijako_osaalue', 400), 90000),
  ]);

  const streets = {};
  for (const feature of requireFeatures(addresses, 40000, 'Address register')) {
    const point = feature.geometry?.coordinates;
    if (!point) continue;
    const { katunimi, gatan, osoitenumero, osoitekirjain } = feature.properties;
    const entry = [
      typeof osoitenumero === 'number' ? osoitenumero : null,
      osoitekirjain || '',
      round(point[1]),
      round(point[0]),
    ];
    for (const name of [katunimi, gatan]) {
      if (!name) continue;
      const key = name.toLowerCase();
      (streets[key] ||= []).push(entry);
    }
  }

  const places = {};
  for (const feature of requireFeatures(names, 5000, 'Place-name register')) {
    const point = feature.geometry?.coordinates;
    if (!point) continue;
    for (const name of [feature.properties.nimi, feature.properties.nimi_sv]) {
      if (!name) continue;
      const key = name.toLowerCase();
      if (!places[key]) places[key] = [round(point[1]), round(point[0])];
    }
  }

  const districtIndex = {};
  for (const [collection, minimum, source] of [[districts, 50, 'Kaupunginosajako'], [subDistricts, 100, 'Piirijako_osaalue']]) {
    for (const feature of requireFeatures(collection, minimum, source)) {
      for (const name of [feature.properties.nimi_fi, feature.properties.nimi_se]) {
        if (!name) continue;
        const centre = polygonCentre(feature.geometry);
        const key = name.toLowerCase();
        if (centre && !districtIndex[key]) districtIndex[key] = centre;
      }
    }
  }

  // No build timestamp: the registers change slowly, and a timestamp would force
  // a 4 MB commit every month even when nothing moved. Git history records when
  // it was last rebuilt.
  const gazetteer = {
    schemaVersion: 1,
    counts: {
      streets: Object.keys(streets).length,
      addresses: Object.values(streets).reduce((sum, points) => sum + points.length, 0),
      places: Object.keys(places).length,
      districts: Object.keys(districtIndex).length,
    },
    streets,
    places,
    districts: districtIndex,
  };

  await mkdir(new URL('.', OUTPUT), { recursive: true });
  await writeFile(OUTPUT, `${JSON.stringify(gazetteer)}\n`, 'utf8');
  console.log('Gazetteer written:', gazetteer.counts);
}

await main();
