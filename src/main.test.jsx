// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  activePresetKey, addDays, byStartDate, categoryCounts, chunkKeysForRange, defaultRange, displayHours,
  describeArea, formatPeriod, formatRange, groupByLocation, isManifestUsable, isoToday, locationKey,
  matchesFilter, mergeNotices, noticeCategory, noticeLabelAt, noticeOverlapsRange, normaliseRange,
  noticeSpan, rangePresets, readJsonCache, unlocatedNotices, writeJsonCache,
} from './main.jsx';

const manifest = {
  schemaVersion: 1,
  generatedAt: '2026-08-09T03:23:00Z',
  totalNotices: 1485,
  chunks: [
    { key: 'current', file: 'notices-current.json', count: 103 },
    { key: '2028', file: 'notices-2028.json', count: 11 },
    { key: '2027', file: 'notices-2027.json', count: 41 },
    { key: '2026', file: 'notices-2026.json', count: 240 },
    ...[2025, 2024, 2023, 2022, 2021, 2020, 2019].map((year) => ({
      key: String(year), file: `notices-${year}.json`, count: 160,
    })),
    { key: '2016', file: 'notices-2016.json', count: 0 },
  ],
};

const notice = (id, overrides = {}) => ({
  id,
  title: `Notice ${id}`,
  category: 'construction',
  decisionDate: '2026-07-01',
  start: '2026-08-01',
  end: '2026-08-31',
  hours: [],
  nightWork: false,
  locations: [],
  ...overrides,
});

describe('date handling', () => {
  it('defaults to a seven-day window starting today', () => {
    const range = defaultRange('2026-08-09');
    expect(range).toEqual({ from: '2026-08-09', to: '2026-08-15' });
  });

  it('crosses month and year boundaries', () => {
    expect(addDays('2026-08-31', 1)).toBe('2026-09-01');
    expect(addDays('2026-12-30', 5)).toBe('2027-01-04');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('reads today in local time, not UTC', () => {
    expect(isoToday(new Date('2026-08-09T23:30:00+03:00'))).toBe('2026-08-09');
  });

  it('spans a notice by its validity, falling back to the decision date', () => {
    expect(noticeSpan(notice('a'))).toEqual({ start: '2026-08-01', end: '2026-08-31' });
    expect(noticeSpan(notice('b', { start: null, end: null }))).toEqual({ start: '2026-07-01', end: '2026-07-01' });
    expect(noticeSpan({ start: null, end: null, decisionDate: null })).toBeNull();
  });
});

describe('period filtering', () => {
  const range = { from: '2026-08-09', to: '2026-08-15' };

  it('includes notices that merely overlap the window at either edge', () => {
    expect(noticeOverlapsRange(notice('a', { start: '2026-08-15', end: '2028-05-31' }), range)).toBe(true);
    expect(noticeOverlapsRange(notice('b', { start: '2026-01-01', end: '2026-08-09' }), range)).toBe(true);
    expect(noticeOverlapsRange(notice('c', { start: '2026-08-16', end: '2026-08-20' }), range)).toBe(false);
    expect(noticeOverlapsRange(notice('d', { start: '2026-08-01', end: '2026-08-08' }), range)).toBe(false);
  });

  it('counts categories across the whole window', () => {
    const counts = categoryCounts([notice('a'), notice('b'), notice('c', { category: 'event' })]);
    expect(counts.get('construction')).toBe(2);
    expect(counts.get('event')).toBe(1);
  });
});

describe('lazy chunk selection', () => {
  it('asks only for the years the period actually reaches', () => {
    expect(chunkKeysForRange({ from: '2026-08-09', to: '2026-08-15' }, manifest)).toEqual(['2026']);
    expect(chunkKeysForRange({ from: '2026-12-20', to: '2027-01-10' }, manifest).sort()).toEqual(['2026', '2027']);
  });

  it('skips years the manifest reports as empty or absent', () => {
    expect(chunkKeysForRange({ from: '2016-01-01', to: '2016-12-31' }, manifest)).toEqual([]);
    expect(chunkKeysForRange({ from: '2011-01-01', to: '2011-12-31' }, manifest)).toEqual([]);
  });

  it('rejects a manifest that has no current slice', () => {
    expect(isManifestUsable(manifest)).toBe(true);
    expect(isManifestUsable({ schemaVersion: 1, chunks: [{ key: '2026' }] })).toBe(false);
    expect(isManifestUsable({ schemaVersion: 2, chunks: [{ key: 'current' }] })).toBe(false);
    expect(isManifestUsable(null)).toBe(false);
  });

  it('merges overlapping chunks without duplicating a notice', () => {
    // A multi-year notice is written into every year chunk it spans.
    const first = mergeNotices(new Map(), [notice('a'), notice('b')]);
    const merged = mergeNotices(first, [notice('b'), notice('c')]);
    expect([...merged.keys()]).toEqual(['a', 'b', 'c']);
  });
});

describe('grouping by location', () => {
  const spot = (lat, lon, extra = {}) => ({ lat, lon, precision: 'address', label: 'Testikatu 1', district: null, ...extra });

  it('collects every notice sharing a point into one marker', () => {
    const groups = groupByLocation([
      notice('a', { locations: [spot(60.1701, 24.9384)] }),
      notice('b', { locations: [spot(60.17012, 24.93841)] }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].notices.map((item) => item.id)).toEqual(['a', 'b']);
  });

  it('gives a multi-site notice a marker at each site', () => {
    const groups = groupByLocation([
      notice('a', { locations: [spot(60.17, 24.93, { label: 'Karhupuisto' }), spot(60.19, 24.95, { label: 'Suvilahti' })] }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.every((group) => group.notices.length === 1)).toBe(true);
  });

  it('prefers a precise label when notices disagree about the same point', () => {
    const groups = groupByLocation([
      notice('a', { locations: [spot(60.17, 24.93, { precision: 'district', label: 'Kamppi' })] }),
      notice('b', { locations: [spot(60.17, 24.93, { precision: 'address', label: 'Lönnrotinkatu 37' })] }),
    ]);
    expect(groups[0].location.label).toBe('Lönnrotinkatu 37');
  });

  it('orders the notices at one point by when they start', () => {
    const spot60 = () => spot(60.17, 24.93);
    const groups = groupByLocation([
      notice('late', { locations: [spot60()], start: '2026-09-01', end: '2026-09-30' }),
      notice('early', { locations: [spot60()], start: '2026-08-01', end: '2026-12-31' }),
      notice('middle', { locations: [spot60()], start: '2026-08-15', end: '2026-08-20' }),
    ]);
    expect(groups[0].notices.map((item) => item.id)).toEqual(['early', 'middle', 'late']);
  });

  it('falls back to the decision date when a notice states no period', () => {
    expect(byStartDate(
      { start: null, end: null, decisionDate: '2026-01-01', title: 'a' },
      { start: '2026-06-01', end: '2026-06-02', title: 'b' },
    )).toBeLessThan(0);
  });

  it('orders busier locations first', () => {
    const groups = groupByLocation([
      notice('a', { locations: [spot(60.10, 24.90)] }),
      notice('b', { locations: [spot(60.20, 24.95)] }),
      notice('c', { locations: [spot(60.20, 24.95)] }),
    ]);
    expect(groups[0].notices).toHaveLength(2);
  });

  it('separates notices that could not be located', () => {
    const notices = [notice('a', { locations: [spot(60.17, 24.93)] }), notice('b')];
    expect(groupByLocation(notices)).toHaveLength(1);
    expect(unlocatedNotices(notices).map((item) => item.id)).toEqual(['b']);
    // The list without locations is ordered the same way.
    expect(unlocatedNotices([
      notice('later', { start: '2026-09-01' }),
      notice('sooner', { start: '2026-08-01' }),
    ]).map((item) => item.id)).toEqual(['sooner', 'later']);
  });

  it('keys locations at a stable precision', () => {
    expect(locationKey({ lat: 60.170123, lon: 24.938456 })).toBe('60.1701:24.9385');
  });

  it('reports the address a notice itself named at a shared point', () => {
    // Corner buildings carry two street addresses on one register point.
    const corner = notice('a', { locations: [spot(60.163499, 24.928824, { label: 'Lönnrotinkatu 37' })] });
    expect(noticeLabelAt(corner, locationKey(corner.locations[0]))).toBe('Lönnrotinkatu 37');
    expect(noticeLabelAt(corner, '0:0')).toBeNull();
  });
});

describe('categories', () => {
  const t = { presetToday: 'Tänään', presetWeek: '7 vrk', presetMonth: '30 vrk', presetYear: 'Tämä vuosi' };

  it('reads one type per notice and defaults unknown values to other', () => {
    expect(noticeCategory({ category: 'event' })).toBe('event');
    expect(noticeCategory({ category: 'blasting' })).toBe('other');
    expect(noticeCategory({})).toBe('other');
  });

  it('counts every type, including the ones with no notices', () => {
    const counts = categoryCounts([
      notice('a', { category: 'construction' }),
      notice('b', { category: 'event' }),
      notice('c', { category: 'construction' }),
    ]);
    expect(counts.get('construction')).toBe(2);
    expect(counts.get('event')).toBe(1);
    expect(counts.get('other')).toBe(0);
  });

  it('hides a notice only when its own type is switched off', () => {
    const site = notice('a', { category: 'construction' });
    expect(matchesFilter(site, new Set())).toBe(true);
    expect(matchesFilter(site, new Set(['event']))).toBe(true);
    expect(matchesFilter(site, new Set(['construction']))).toBe(false);
  });

  it('describes a watch area in plain terms', () => {
    const square = [[60.16, 24.92], [60.16, 24.945], [60.172, 24.945], [60.172, 24.92]];
    expect(describeArea(square, { corners: 'kulmaa' })).toMatch(/km², 4 kulmaa$/);
  });

  it('marks the quick range that matches the current selection', () => {
    const presets = rangePresets(t, '2026-08-09');
    expect(presets.map((preset) => preset.key)).toEqual(['today', 'week', 'month', 'year']);
    expect(presets[1]).toMatchObject({ from: '2026-08-09', to: '2026-08-15' });
    expect(presets[2]).toMatchObject({ from: '2026-08-09', to: '2026-09-07' });
    expect(presets[3]).toMatchObject({ from: '2026-01-01', to: '2026-12-31' });

    expect(activePresetKey({ from: '2026-08-09', to: '2026-08-15' }, presets)).toBe('week');
    expect(activePresetKey({ from: '2019-05-01', to: '2019-05-31' }, presets)).toBeNull();
  });
});

describe('custom range entry', () => {
  it('orders a reversed draft rather than rejecting it', () => {
    expect(normaliseRange({ from: '2019-05-31', to: '2019-05-01' }))
      .toEqual({ from: '2019-05-01', to: '2019-05-31' });
    expect(normaliseRange({ from: '2026-08-09', to: '2026-08-15' }))
      .toEqual({ from: '2026-08-09', to: '2026-08-15' });
  });

  it('does not touch chunks for a half-edited range, because it is never applied', () => {
    // The user sets the start year first; only the applied range selects chunks.
    const halfEdited = { from: '2019-05-01', to: '2026-08-15' };
    expect(chunkKeysForRange(halfEdited, manifest)).toHaveLength(8);
    expect(chunkKeysForRange(normaliseRange({ from: '2019-05-01', to: '2019-05-31' }), manifest)).toEqual(['2019']);
  });
});

describe('presentation', () => {
  it('collapses a single-day period to one date', () => {
    expect(formatPeriod(notice('a', { start: '2026-08-25', end: '2026-08-25' }), 'fi')).toBe('25.8.2026');
    expect(formatPeriod(notice('b', { start: '2026-08-10', end: '2026-09-30' }), 'fi')).toBe('10.8.2026–30.9.2026');
  });

  it('drops the repeated year from a range within one year', () => {
    expect(formatRange({ from: '2026-08-09', to: '2026-08-15' }, 'fi')).toBe('9.8.\u201315.8.2026');
    expect(formatRange({ from: '2026-12-20', to: '2027-01-10' }, 'fi')).toBe('20.12.2026\u201310.1.2027');
    expect(formatRange({ from: '2026-08-09', to: '2026-08-09' }, 'fi')).toBe('9.8.2026');
  });

  it('shows permitted working hours in preference to the boilerplate night ban', () => {
    const hours = [
      { kind: 'prohibited', from: '22:00', to: '07:00' },
      { kind: 'allowed', from: '07:00', to: '18:00' },
    ];
    expect(displayHours(hours)).toEqual([{ kind: 'allowed', from: '07:00', to: '18:00' }]);
    expect(displayHours([{ kind: 'unknown', from: '09:00', to: '23:00' }]))
      .toEqual([{ kind: 'unknown', from: '09:00', to: '23:00' }]);
    expect(displayHours([])).toEqual([]);
  });
});

describe('cache', () => {
  const fakeStorage = () => {
    const store = new Map();
    return {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, value),
    };
  };

  it('round-trips a value and expires it by age', () => {
    const storage = fakeStorage();
    writeJsonCache(storage, 'chunk:2026', { notices: [] }, 1000);
    expect(readJsonCache(storage, 'chunk:2026', 5000, 3000)).toEqual({ notices: [] });
    expect(readJsonCache(storage, 'chunk:2026', 5000, 9000)).toBeNull();
    expect(readJsonCache(storage, 'missing', 5000, 1000)).toBeNull();
  });

  it('degrades quietly when storage is unavailable', () => {
    expect(writeJsonCache(null, 'k', 1)).toBe(false);
    expect(readJsonCache(null, 'k', 1000)).toBeNull();
  });
});
