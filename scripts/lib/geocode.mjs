// Resolves Finnish place references in decision text to coordinates using the
// committed gazetteer. No network access and no API keys: every name comes from
// Helsinki's own open address, place-name and district registers.
//
// A notice can legitimately name several sites ("Karhupuistossa ja Suvilahdessa"),
// so resolution returns a list rather than a single point.

// Finnish street suffixes inflect predictably, so surface forms can be generated
// rather than stemmed. This avoids the false matches aggressive stemming causes.
const SUFFIX_FORMS = {
  katu: ['kadulla', 'kadun', 'katua', 'kadulle', 'kadulta', 'kadut'],
  tie: ['tiellä', 'tien', 'tietä', 'tielle', 'tieltä'],
  kuja: ['kujalla', 'kujan', 'kujaa', 'kujalle'],
  polku: ['polulla', 'polun', 'polkua'],
  väylä: ['väylällä', 'väylän', 'väylää'],
  ranta: ['rannalla', 'rannan', 'rantaa', 'rannassa'],
  laituri: ['laiturilla', 'laiturin', 'laituria', 'laiturissa'],
  aukio: ['aukiolla', 'aukion', 'aukiota'],
  tori: ['torilla', 'torin', 'toria'],
  puisto: ['puistossa', 'puiston', 'puistoa'],
  kaari: ['kaarella', 'kaaren'],
  raitti: ['raitilla', 'raitin'],
  silta: ['sillalla', 'sillan'],
  penger: ['penkereellä', 'penkereen'],
  rinne: ['rinteellä', 'rinteen'],
  mäki: ['mäellä', 'mäen'],
  kallio: ['kalliolla', 'kallion'],
  niitty: ['niityllä', 'niityn'],
  portti: ['portilla', 'portin'],
  linja: ['linjalla', 'linjan'],
  kenttä: ['kentällä', 'kentän'],
  saari: ['saaressa', 'saaren'],
  lahti: ['lahdessa', 'lahden'],
  nokka: ['nokassa', 'nokan'],
  vuori: ['vuorella', 'vuoren'],
  harju: ['harjulla', 'harjun'],
  kumpu: ['kummulla', 'kummun'],
};

const MAX_LOCATIONS = 8;
// Two streets are only a junction if their nearest address points nearly touch.
const JUNCTION_MAX_DEGREES_SQ = 0.0000025; // roughly 200 m at Helsinki's latitude
const JUNCTION_CUES = /risteys|risteyksess|kulmass|v[aä]lise|v[aä]lill|kohdalla|liittym/i;

// Area names take the local cases; -i stems also drop to -e (Munkkiniemi -> Munkkiniemessa).
export function areaForms(base) {
  const b = base.toLowerCase();
  const forms = new Set([b, `${b}ssa`, `${b}ssä`, `${b}lla`, `${b}llä`, `${b}n`]);
  if (b.endsWith('i')) {
    const stem = b.slice(0, -1);
    for (const suffix of ['essa', 'essä', 'ella', 'ellä', 'en', 'in', 'issa', 'issä']) forms.add(stem + suffix);
  }
  if (b.endsWith('a') || b.endsWith('ä')) {
    const stem = b.slice(0, -1);
    for (const suffix of ['an', 'än', 'assa', 'ässä']) forms.add(stem + suffix);
  }
  return forms;
}

function inflect(name) {
  for (const [suffix, forms] of Object.entries(SUFFIX_FORMS)) {
    if (name.endsWith(suffix)) {
      const stem = name.slice(0, -suffix.length);
      return [name, ...forms.map((form) => stem + form)];
    }
  }
  return [name, ...areaForms(name)];
}

export function normalize(value) {
  return (value || '')
    .toLowerCase()
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\s ]+/g, ' ')
    .trim();
}

export function round(value) {
  return Math.round(value * 1e6) / 1e6;
}

export function buildIndex(gazetteer) {
  const streets = new Map(Object.entries(gazetteer.streets));
  const places = new Map(Object.entries(gazetteer.places));
  const districts = new Map(Object.entries(gazetteer.districts));

  const streetForms = new Map();
  for (const name of streets.keys()) {
    for (const form of inflect(name)) if (!streetForms.has(form)) streetForms.set(form, name);
  }
  const placeForms = new Map();
  for (const name of places.keys()) {
    if (districts.has(name) || streets.has(name)) continue;
    for (const form of inflect(name)) if (!placeForms.has(form)) placeForms.set(form, name);
  }
  const districtForms = new Map();
  for (const name of districts.keys()) {
    // inflect() covers consonant gradation for -lahti/-mäki/-saari district names
    // (Aurinkolahti -> Aurinkolahden), which plain case endings would miss.
    for (const form of inflect(name)) if (!districtForms.has(form)) districtForms.set(form, name);
  }
  return { streets, places, districts, streetForms, placeForms, districtForms };
}

function centroid(points) {
  const lat = points.reduce((sum, point) => sum + point[2], 0) / points.length;
  const lon = points.reduce((sum, point) => sum + point[3], 0) / points.length;
  return [round(lat), round(lon)];
}

function distanceSq(a, b) {
  // Planar approximation, adequate at Helsinki's latitude for ranking nearby points.
  const dLat = a[0] - b[0];
  const dLon = (a[1] - b[1]) * 0.5;
  return dLat * dLat + dLon * dLon;
}

export function titleCase(value) {
  return (value || '')
    .split(/([ -])/)
    .map((part) => (part === ' ' || part === '-' ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('');
}

const WORD_RE = /[A-Za-zÅÄÖåäö][\wÅÄÖåäö-]{4,}/g;
// Street names run from one token to three ("Antti Korpin tie", "John Stenbergin ranta").
const NUMBERED_RE = /([A-ZÅÄÖ][\wåäö-]+(?:\s+[A-Za-zÅÄÖåäö][\wåäö-]+){0,2})\s+(\d{1,4})\s*([a-zA-Z])?(?![\w.])/g;

function mentionedNames(text, forms, minLength = 5) {
  const found = [];
  const consider = (word) => {
    if (word.length < minLength) return;
    const base = forms.get(word);
    if (base && !found.includes(base)) found.push(base);
  };
  for (const match of normalize(text).matchAll(WORD_RE)) {
    const word = match[0];
    consider(word);
    // "Mannerheimintie-Kaivokatu risteysalue" joins two street names with a hyphen,
    // while hyphens are also internal to single names (Taka-Töölö), so try both.
    if (word.includes('-')) word.split('-').forEach(consider);
  }
  return found;
}

function resolveNumber(points, number, letter) {
  const exact = points.filter((point) => point[0] === number
    && (!letter || !point[1] || normalize(point[1]) === normalize(letter)));
  if (exact.length) return { point: exact[0], precision: 'address' };
  const numbered = points.filter((point) => typeof point[0] === 'number');
  if (numbered.length) {
    const nearest = numbered.reduce((best, point) => (
      Math.abs(point[0] - number) < Math.abs(best[0] - number) ? point : best));
    // Only trust a neighbouring number, not an arbitrary one further down the street.
    if (Math.abs(nearest[0] - number) <= 6) return { point: nearest, precision: 'address-approx' };
  }
  return null;
}

// "Lastenkodinkatu 11 ja Mechelininkatu 24", the second address carries no
// "osoitteessa" cue, so any gazetteer street followed by a number counts.
function findAddresses(index, text) {
  const found = [];
  for (const match of text.matchAll(NUMBERED_RE)) {
    // Prefer the longest name that exists in the register, then shorter tails.
    const tokens = match[1].split(/\s+/);
    const candidates = tokens.map((_, offset) => tokens.slice(offset).join(' '));
    for (const candidate of candidates) {
      const points = index.streets.get(normalize(candidate));
      if (!points) continue;
      const resolved = resolveNumber(points, Number(match[2]), match[3]);
      if (!resolved) continue;
      found.push({
        lat: round(resolved.point[2]),
        lon: round(resolved.point[3]),
        precision: resolved.precision,
        label: `${titleCase(normalize(candidate))} ${match[2]}${match[3] || ''}`,
      });
      break;
    }
  }
  return found;
}

function junction(pointsA, pointsB) {
  let best = null;
  for (const a of pointsA) {
    for (const b of pointsB) {
      const d = distanceSq([a[2], a[3]], [b[2], b[3]]);
      if (!best || d < best.d) best = { d, lat: (a[2] + b[2]) / 2, lon: (a[3] + b[3]) / 2 };
    }
  }
  return best;
}

function narrowToDistrict(points, anchor) {
  if (!anchor || points.length < 2) return points;
  const near = points.filter((point) => distanceSq([point[2], point[3]], anchor) < 0.0004);
  return near.length ? near : points;
}

function dedupe(locations) {
  const seen = new Set();
  const unique = [];
  for (const location of locations) {
    const key = `${location.lat.toFixed(4)}:${location.lon.toFixed(4)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(location);
    if (unique.length >= MAX_LOCATIONS) break;
  }
  return unique;
}

/**
 * Resolve every site a decision names.
 * `text` should be the subject's activity part plus the operative clause, never
 * the applicant's name, which frequently contains a place name of its own
 * ("Drumsö Idrottskamrater", "Helsingin Talosiirto Oy").
 */
export function locateAll(index, text) {
  if (!text) return [];
  const districtNames = mentionedNames(text, index.districtForms);
  const district = districtNames[0] || null;
  const anchor = district ? index.districts.get(district) : null;
  const withDistrict = (locations) => locations.map((location) => ({
    ...location,
    district: district ? titleCase(district) : null,
  }));

  const addresses = findAddresses(index, text);
  if (addresses.length) return withDistrict(dedupe(addresses));

  const streetNames = mentionedNames(text, index.streetForms, 6);
  const placeNames = mentionedNames(text, index.placeForms, 6);

  if (streetNames.length === 2 && !placeNames.length && JUNCTION_CUES.test(text)) {
    const spot = junction(index.streets.get(streetNames[0]), index.streets.get(streetNames[1]));
    if (spot && spot.d <= JUNCTION_MAX_DEGREES_SQ) {
      return withDistrict([{
        lat: round(spot.lat),
        lon: round(spot.lon),
        precision: 'intersection',
        label: `${titleCase(streetNames[0])} / ${titleCase(streetNames[1])}`,
      }]);
    }
  }

  const named = [];
  for (const name of streetNames) {
    const [lat, lon] = centroid(narrowToDistrict(index.streets.get(name), anchor));
    named.push({ lat, lon, precision: 'street', label: titleCase(name) });
  }
  for (const name of placeNames) {
    const [lat, lon] = index.places.get(name);
    named.push({ lat: round(lat), lon: round(lon), precision: 'place', label: titleCase(name) });
  }
  if (named.length) return withDistrict(dedupe(named));

  if (district) {
    const [lat, lon] = index.districts.get(district);
    return [{
      lat: round(lat), lon: round(lon), precision: 'district', label: titleCase(district), district: titleCase(district),
    }];
  }
  return [];
}
