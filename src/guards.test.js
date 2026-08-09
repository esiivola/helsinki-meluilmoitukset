import { describe, expect, it } from 'vitest';
import {
  GUARDS_KEY, MAX_GUARDS, acknowledgeNotices, boundsToPolygon, clearAllGuards, clearGuard,
  createGuard, isValidGuard, matchesCategories, nextGuardId, noticeInArea, noticeMatchesGuard,
  pendingByGuard, pendingForGuard, pointInPolygon, polygonAreaKm2, polygonBounds, readGuards,
  totalPending, writeGuards,
} from './guards.js';

// A square roughly covering Kamppi and Punavuori.
const AREA = [[60.160, 24.920], [60.160, 24.945], [60.172, 24.945], [60.172, 24.920]];

const notice = (id, overrides = {}) => ({
  id,
  title: `Notice ${id}`,
  category: 'construction',
  decisionDate: '2026-08-20',
  locations: [{ lat: 60.165, lon: 24.930, precision: 'address', label: 'Testikatu 1' }],
  ...overrides,
});

const guard = (overrides = {}) => ({
  id: 'vahti-1',
  name: 'Koti',
  polygon: AREA,
  categories: [],
  createdAt: '2026-08-09T06:00:00.000Z',
  baselineDate: '2026-08-09',
  acknowledged: [],
  ...overrides,
});

const fakeStorage = () => {
  const store = new Map();
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, value),
  };
};

describe('area geometry', () => {
  it('places points inside and outside a drawn area', () => {
    expect(pointInPolygon([60.165, 24.930], AREA)).toBe(true);
    expect(pointInPolygon([60.190, 24.930], AREA)).toBe(false);
    expect(pointInPolygon([60.165, 24.900], AREA)).toBe(false);
  });

  it('handles a concave area, where a bounding box would be wrong', () => {
    // An L shape: the notch must not count as inside.
    const lShape = [[0, 0], [0, 4], [2, 4], [2, 2], [4, 2], [4, 0]];
    expect(pointInPolygon([1, 1], lShape)).toBe(true);
    expect(pointInPolygon([3, 3], lShape)).toBe(false);
  });

  it('refuses a degenerate area rather than matching everything', () => {
    expect(pointInPolygon([60.165, 24.930], [[60.16, 24.92], [60.17, 24.94]])).toBe(false);
    expect(pointInPolygon([60.165, 24.930], [])).toBe(false);
  });

  it('turns the map view into an area for the keyboard route', () => {
    const polygon = boundsToPolygon({ south: 60.16, west: 24.92, north: 60.17, east: 24.94 });
    expect(polygon).toHaveLength(4);
    expect(pointInPolygon([60.165, 24.93], polygon)).toBe(true);
  });

  it('measures a bounding box and a rough area', () => {
    expect(polygonBounds(AREA)).toEqual({ south: 60.160, north: 60.172, west: 24.920, east: 24.945 });
    const km2 = polygonAreaKm2(AREA);
    expect(km2).toBeGreaterThan(1);
    expect(km2).toBeLessThan(3);
  });
});

describe('matching a notice to a watch', () => {
  it('treats an empty type list as every type', () => {
    expect(matchesCategories(notice('a'), [])).toBe(true);
    expect(matchesCategories(notice('a'), ['event'])).toBe(false);
    expect(matchesCategories(notice('a'), ['event', 'construction'])).toBe(true);
  });

  it('treats an unknown or missing type as other', () => {
    expect(matchesCategories({ category: 'event' }, ['event'])).toBe(true);
    expect(matchesCategories({}, ['other'])).toBe(true);
  });

  it('matches when any one of several sites falls inside the area', () => {
    const spread = notice('a', {
      locations: [
        { lat: 60.250, lon: 25.100 },
        { lat: 60.165, lon: 24.930 },
      ],
    });
    expect(noticeInArea(spread, AREA)).toBe(true);
    expect(noticeInArea(notice('b', { locations: [] }), AREA)).toBe(false);
  });

  it('requires both the area and the type to match', () => {
    const watch = guard({ categories: ['event'] });
    expect(noticeMatchesGuard(notice('a'), watch)).toBe(false);
    expect(noticeMatchesGuard(notice('b', { category: 'event' }), watch)).toBe(true);
  });
});

describe('what a watch reports', () => {
  it('reports notices decided on or after the day it was created', () => {
    const watch = guard();
    const notices = [
      notice('new', { decisionDate: '2026-08-20' }),
      notice('same-day', { decisionDate: '2026-08-09' }),
      notice('older', { decisionDate: '2026-08-08' }),
    ];
    expect(pendingForGuard(notices, watch).map((item) => item.id)).toEqual(['new', 'same-day']);
  });

  it('starts quiet: everything already decided is cleared when the watch is saved', () => {
    const existing = [
      notice('a', { decisionDate: '2026-08-09' }),
      notice('b', { decisionDate: '2026-07-01' }),
    ];
    const watch = createGuard({
      id: 'vahti-1', name: 'Koti', polygon: AREA, notices: existing, now: new Date('2026-08-09T06:00:00Z'),
    });
    expect(pendingForGuard(existing, watch)).toEqual([]);
    // A decision published later still gets through.
    expect(pendingForGuard([...existing, notice('c', { decisionDate: '2026-08-11' })], watch)
      .map((item) => item.id)).toEqual(['c']);
  });

  it('keeps reporting until cleared, however many times the page is loaded', () => {
    const watch = guard();
    const notices = [notice('a'), notice('b')];
    expect(pendingForGuard(notices, watch)).toHaveLength(2);
    // Re-reading changes nothing; only an explicit clear does.
    expect(pendingForGuard(notices, watch)).toHaveLength(2);

    const afterOne = acknowledgeNotices(watch, ['a']);
    expect(pendingForGuard(notices, afterOne).map((item) => item.id)).toEqual(['b']);

    const afterAll = clearGuard(afterOne, notices);
    expect(pendingForGuard(notices, afterAll)).toEqual([]);
  });

  it('does not resurrect a cleared notice', () => {
    const watch = clearGuard(guard(), [notice('a')]);
    expect(pendingForGuard([notice('a')], watch)).toEqual([]);
  });

  it('reports newest first', () => {
    const notices = [
      notice('old', { decisionDate: '2026-08-11' }),
      notice('new', { decisionDate: '2026-08-25' }),
    ];
    expect(pendingForGuard(notices, guard()).map((item) => item.id)).toEqual(['new', 'old']);
  });

  it('keeps several watches independent and totals them', () => {
    const home = guard({ id: 'vahti-1', categories: ['construction'] });
    const work = guard({ id: 'vahti-2', categories: ['event'] });
    const notices = [notice('a'), notice('b', { category: 'event' })];

    const perGuard = pendingByGuard(notices, [home, work]);
    expect(perGuard[0].notices.map((item) => item.id)).toEqual(['a']);
    expect(perGuard[1].notices.map((item) => item.id)).toEqual(['b']);
    expect(totalPending(notices, [home, work])).toBe(2);

    const cleared = clearAllGuards([home, work], notices);
    expect(totalPending(notices, cleared)).toBe(0);
  });
});

describe('saved watches', () => {
  it('round-trips through storage', () => {
    const storage = fakeStorage();
    const watch = guard();
    expect(writeGuards(storage, [watch])).toBe(true);
    expect(readGuards(storage)).toEqual([watch]);
    expect(storage.getItem(GUARDS_KEY)).toContain('schemaVersion');
  });

  it('ignores a missing, corrupt or foreign payload instead of throwing', () => {
    const storage = fakeStorage();
    expect(readGuards(storage)).toEqual([]);
    storage.setItem(GUARDS_KEY, 'not json');
    expect(readGuards(storage)).toEqual([]);
    storage.setItem(GUARDS_KEY, JSON.stringify({ schemaVersion: 99, guards: [guard()] }));
    expect(readGuards(storage)).toEqual([]);
    expect(readGuards(null)).toEqual([]);
    expect(writeGuards(null, [])).toBe(false);
  });

  it('drops watches that would match nothing meaningful', () => {
    const storage = fakeStorage();
    writeGuards(storage, [guard(), guard({ id: 'bad', polygon: [[60.1, 24.9]] })]);
    expect(readGuards(storage).map((item) => item.id)).toEqual(['vahti-1']);
    expect(isValidGuard(guard())).toBe(true);
    expect(isValidGuard({ ...guard(), polygon: 'nope' })).toBe(false);
  });

  it('caps how many watches are kept', () => {
    const many = Array.from({ length: MAX_GUARDS + 5 }, (_, index) => guard({ id: `vahti-${index}` }));
    const storage = fakeStorage();
    writeGuards(storage, many);
    expect(readGuards(storage)).toHaveLength(MAX_GUARDS);
  });

  it('names a new watch without colliding', () => {
    expect(nextGuardId([])).toBe('vahti-1');
    expect(nextGuardId([guard({ id: 'vahti-1' })])).toBe('vahti-2');
    expect(nextGuardId([guard({ id: 'vahti-1' }), guard({ id: 'vahti-2' })])).toBe('vahti-3');
  });
});
