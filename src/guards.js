// Area watches ("vahdit"). A watch is an area the reader drew on the map plus an
// optional set of noise types. It reports notices that appeared after the watch
// was created and that the reader has not yet cleared.
//
// Everything lives in the browser. Nothing is sent anywhere, and there is no
// server that could receive it.

export const GUARDS_SCHEMA_VERSION = 1;
export const GUARDS_KEY = 'helsinki-melu:v1:guards';
export const MAX_GUARDS = 12;

/**
 * Ray casting. Returns true for a point strictly inside the ring and is stable
 * on shared edges, which is all a drawn area needs.
 */
export function pointInPolygon(point, polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) return false;
  const [lat, lon] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [latI, lonI] = polygon[i];
    const [latJ, lonJ] = polygon[j];
    const straddles = (lonI > lon) !== (lonJ > lon);
    if (!straddles) continue;
    const crossingLat = latI + ((lon - lonI) / (lonJ - lonI)) * (latJ - latI);
    if (lat < crossingLat) inside = !inside;
  }
  return inside;
}

export function polygonBounds(polygon) {
  if (!Array.isArray(polygon) || !polygon.length) return null;
  return polygon.reduce((box, [lat, lon]) => ({
    south: Math.min(box.south, lat),
    north: Math.max(box.north, lat),
    west: Math.min(box.west, lon),
    east: Math.max(box.east, lon),
  }), { south: 90, north: -90, west: 180, east: -180 });
}

// The keyboard route to creating a watch: turn the current map view into a area.
export function boundsToPolygon({ south, west, north, east }) {
  return [[south, west], [south, east], [north, east], [north, west]];
}

/** Rough area in square kilometres, used only to describe a watch in words. */
export function polygonAreaKm2(polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) return 0;
  const midLat = polygon.reduce((sum, [lat]) => sum + lat, 0) / polygon.length;
  const kmPerDegreeLat = 111.32;
  const kmPerDegreeLon = 111.32 * Math.cos((midLat * Math.PI) / 180);
  let twiceArea = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [latI, lonI] = polygon[i];
    const [latJ, lonJ] = polygon[j];
    twiceArea += (lonJ * kmPerDegreeLon) * (latI * kmPerDegreeLat)
      - (lonI * kmPerDegreeLon) * (latJ * kmPerDegreeLat);
  }
  return Math.abs(twiceArea) / 2;
}

// An empty type list means every type, which keeps a freshly drawn watch useful
// before the reader narrows it.
export function matchesCategories(notice, categories) {
  if (!Array.isArray(categories) || !categories.length) return true;
  return categories.includes(notice?.category || 'other');
}

export function noticeInArea(notice, polygon) {
  return (notice?.locations || []).some((location) => pointInPolygon([location.lat, location.lon], polygon));
}

export function noticeMatchesGuard(notice, guard) {
  return matchesCategories(notice, guard.categories) && noticeInArea(notice, guard.polygon);
}

/**
 * Notices a watch should report.
 *
 * A notice counts as new when it was decided on or after the day the watch was
 * created and has not been cleared. Anchoring on the decision date rather than a
 * stored list of everything seen keeps the saved watch small no matter how large
 * the area is, and it survives the archive being rebuilt.
 */
export function pendingForGuard(notices, guard) {
  const cleared = new Set(guard.acknowledged || []);
  return notices
    .filter((notice) => !cleared.has(notice.id))
    .filter((notice) => (notice.decisionDate || '') >= guard.baselineDate)
    .filter((notice) => noticeMatchesGuard(notice, guard))
    .sort((a, b) => (b.decisionDate || '').localeCompare(a.decisionDate || ''));
}

export function pendingByGuard(notices, guards) {
  return guards.map((guard) => ({ guard, notices: pendingForGuard(notices, guard) }));
}

export function totalPending(notices, guards) {
  return pendingByGuard(notices, guards).reduce((sum, entry) => sum + entry.notices.length, 0);
}

export function createGuard({ id, name, polygon, categories = [], notices = [], now = new Date() }) {
  const createdAt = now.toISOString();
  const baselineDate = createdAt.slice(0, 10);
  const guard = {
    id,
    name: (name || '').trim(),
    polygon,
    categories,
    createdAt,
    baselineDate,
    acknowledged: [],
  };
  // Decisions already published today would otherwise read as new the moment the
  // watch is saved, so they are cleared up front.
  guard.acknowledged = pendingForGuard(notices, guard).map((notice) => notice.id);
  return guard;
}

export function acknowledgeNotices(guard, ids) {
  const cleared = new Set(guard.acknowledged || []);
  for (const id of ids) cleared.add(id);
  return { ...guard, acknowledged: [...cleared] };
}

export function clearGuard(guard, notices) {
  return acknowledgeNotices(guard, pendingForGuard(notices, guard).map((notice) => notice.id));
}

export function clearAllGuards(guards, notices) {
  return guards.map((guard) => clearGuard(guard, notices));
}

export function isValidGuard(guard) {
  return Boolean(guard)
    && typeof guard.id === 'string'
    && Array.isArray(guard.polygon)
    && guard.polygon.length >= 3
    && guard.polygon.every((point) => Array.isArray(point) && point.length === 2
      && Number.isFinite(point[0]) && Number.isFinite(point[1]))
    && Array.isArray(guard.categories)
    && typeof guard.baselineDate === 'string'
    && Array.isArray(guard.acknowledged);
}

export function readGuards(storage) {
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(GUARDS_KEY) || 'null');
    if (parsed?.schemaVersion !== GUARDS_SCHEMA_VERSION || !Array.isArray(parsed.guards)) return [];
    return parsed.guards.filter(isValidGuard).slice(0, MAX_GUARDS);
  } catch {
    return [];
  }
}

export function writeGuards(storage, guards) {
  if (!storage) return false;
  try {
    storage.setItem(GUARDS_KEY, JSON.stringify({
      schemaVersion: GUARDS_SCHEMA_VERSION,
      guards: guards.filter(isValidGuard).slice(0, MAX_GUARDS),
    }));
    return true;
  } catch {
    return false;
  }
}

export function nextGuardId(guards) {
  const used = new Set(guards.map((guard) => guard.id));
  let index = guards.length + 1;
  while (used.has(`vahti-${index}`)) index += 1;
  return `vahti-${index}`;
}
