import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {
  AlertTriangle, CalendarClock, ChevronDown, ExternalLink, Info, Layers3,
  LocateFixed, MapPin, Moon, RefreshCw, X,
} from 'lucide-react';

const HELSINKI = [60.16986, 24.93838];
export const DEFAULT_MAP_ZOOM = 12;
export const DEFAULT_RANGE_DAYS = 7;
const DATA_BASE = `${import.meta.env.BASE_URL}data/`;
const CACHE_PREFIX = 'helsinki-melu:v1:';
const MANIFEST_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const CHUNK_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
const RANGE_SETTLE_MS = 400;
// Same order as the collector's priority list, so the first category on a notice
// is the one that colours its marker.
const CATEGORY_ORDER = [
  'blasting', 'crushing', 'piling', 'drilling', 'demolition',
  'rail', 'marine', 'earthworks', 'event', 'other',
];
// Heavy impulsive work sits in the warm end, infrastructure in blue, events in
// green, so the map still reads at a glance despite ten categories.
const CATEGORY_COLOURS = {
  blasting: '#a32b1f',
  crushing: '#c85c2b',
  piling: '#b08114',
  drilling: '#8a7b22',
  demolition: '#7a5340',
  rail: '#2457d6',
  marine: '#157a72',
  earthworks: '#6d7355',
  event: '#17735a',
  other: '#68716b',
};
const LEGEND_LIMIT = 6;
const IMPRECISE = new Set(['district', 'street']);

/* ------------------------------------------------------------------ storage */

export function writeJsonCache(storage, key, value, now = Date.now()) {
  if (!storage) return false;
  try {
    storage.setItem(`${CACHE_PREFIX}${key}`, JSON.stringify({ savedAt: now, value }));
    return true;
  } catch { return false; }
}

export function readJsonCache(storage, key, maxAge, now = Date.now()) {
  if (!storage) return null;
  try {
    const cached = JSON.parse(storage.getItem(`${CACHE_PREFIX}${key}`) || 'null');
    if (!cached || !Number.isFinite(cached.savedAt) || now - cached.savedAt > maxAge) return null;
    return cached.value;
  } catch { return null; }
}

function browserStorage() {
  try { return typeof window !== 'undefined' ? window.localStorage : null; } catch { return null; }
}

/* --------------------------------------------------------------- date logic */

export function isoToday(now = new Date()) {
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

export function addDays(iso, days) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function defaultRange(today = isoToday()) {
  return { from: today, to: addDays(today, DEFAULT_RANGE_DAYS - 1) };
}

// A notice without a period still has a decision date, so it can be placed in time.
export function noticeSpan(notice) {
  const start = notice.start || notice.decisionDate;
  const end = notice.end || notice.start || notice.decisionDate;
  if (!start || !end) return null;
  return start <= end ? { start, end } : { start: end, end: start };
}

export function noticeOverlapsRange(notice, range) {
  const span = noticeSpan(notice);
  if (!span) return false;
  return span.start <= range.to && span.end >= range.from;
}

// Chunks are named by year, plus a "current" slice that is always loaded first.
export function chunkKeysForRange(range, manifest) {
  if (!manifest?.chunks) return [];
  const first = Number(range.from.slice(0, 4));
  const last = Number(range.to.slice(0, 4));
  const wanted = new Set();
  for (let year = first; year <= last; year += 1) wanted.add(String(year));
  return manifest.chunks
    .filter((chunk) => wanted.has(chunk.key) && chunk.count > 0)
    .map((chunk) => chunk.key);
}

export function isManifestUsable(manifest) {
  return manifest?.schemaVersion === 1
    && Array.isArray(manifest.chunks)
    && manifest.chunks.some((chunk) => chunk.key === 'current');
}

export function mergeNotices(existing, incoming) {
  const merged = new Map(existing);
  for (const notice of incoming) if (notice?.id) merged.set(notice.id, notice);
  return merged;
}

/* -------------------------------------------------------------- presentation */

export function formatDate(iso, locale) {
  if (!iso) return '';
  const [year, month, day] = iso.split('-');
  return locale === 'en' ? `${day}.${month}.${year}` : `${Number(day)}.${Number(month)}.${year}`;
}

export function formatPeriod(notice, locale) {
  const span = noticeSpan(notice);
  if (!span) return '';
  if (span.start === span.end) return formatDate(span.start, locale);
  return `${formatDate(span.start, locale)} – ${formatDate(span.end, locale)}`;
}

// The permitted windows are what a resident actually wants; a blanket night ban
// is boilerplate and only worth showing when nothing else was extracted.
export function displayHours(hours) {
  if (!Array.isArray(hours) || !hours.length) return [];
  const allowed = hours.filter((window) => window.kind === 'allowed');
  if (allowed.length) return allowed.slice(0, 3);
  const unknown = hours.filter((window) => window.kind === 'unknown');
  if (unknown.length) return unknown.slice(0, 3);
  return hours.slice(0, 2);
}

export function locationKey(location) {
  return `${location.lat.toFixed(4)}:${location.lon.toFixed(4)}`;
}

// One marker per distinct point, carrying every notice that sits there.
export function groupByLocation(notices) {
  const groups = new Map();
  for (const notice of notices) {
    for (const location of notice.locations || []) {
      const key = locationKey(location);
      if (!groups.has(key)) groups.set(key, { key, location, notices: [] });
      const group = groups.get(key);
      if (!group.notices.some((item) => item.id === notice.id)) group.notices.push(notice);
      // The most precise label wins when several notices share a point.
      if (!IMPRECISE.has(location.precision) && IMPRECISE.has(group.location.precision)) {
        group.location = location;
      }
    }
  }
  return [...groups.values()].sort((a, b) => b.notices.length - a.notices.length);
}

// Corner buildings share one point under two street addresses, so a group's
// heading can name a street the individual notice never mentions.
export function noticeLabelAt(notice, key) {
  const match = (notice.locations || []).find((location) => locationKey(location) === key);
  return match?.label || null;
}

export function unlocatedNotices(notices) {
  return notices.filter((notice) => !notice.locations?.length);
}

// Records predate multi-label classification in older caches, so fall back to
// the single primary category when the array is missing.
export function noticeCategories(notice) {
  const list = Array.isArray(notice.categories) && notice.categories.length
    ? notice.categories
    : [notice.category || 'other'];
  return list;
}

// A notice counts towards every category it carries, so the totals in the filter
// add up to more than the number of notices. That is the honest reading.
export function categoryCounts(notices) {
  const counts = new Map();
  for (const notice of notices) {
    for (const category of noticeCategories(notice)) {
      counts.set(category, (counts.get(category) || 0) + 1);
    }
  }
  return counts;
}

export function matchesFilter(notice, hidden) {
  return noticeCategories(notice).some((category) => !hidden.has(category));
}

// Only the categories actually on the map, so the legend never lists ten items
// when three are showing.
export function legendCategories(notices, hidden, limit = LEGEND_LIMIT) {
  const present = new Set();
  for (const notice of notices) {
    for (const category of noticeCategories(notice)) {
      if (!hidden.has(category)) present.add(category);
    }
  }
  const ordered = CATEGORY_ORDER.filter((category) => present.has(category));
  return { shown: ordered.slice(0, limit), overflow: Math.max(0, ordered.length - limit) };
}

/* -------------------------------------------------------------------- copy */

const copy = {
  fi: {
    appName: 'MELU',
    region: 'Helsinki',
    period: 'Ajanjakso',
    from: 'Alkaen',
    to: 'Päättyen',
    presetWeek: 'Seuraavat 7 vrk',
    presetToday: 'Tänään',
    presetMonth: 'Seuraavat 30 vrk',
    presetYear: 'Tämä vuosi',
    custom: 'Oma ajanjakso',
    apply: 'Näytä ajanjakso',
    close: 'Sulje',
    noticeCount: 'meluilmoitusta',
    noticeCountOne: 'meluilmoitus',
    empty: 'Valitulla ajanjaksolla ei ole meluilmoituksia.',
    emptyHint: 'Kokeile pidempää ajanjaksoa.',
    loading: 'Haetaan meluilmoituksia…',
    loadError: 'Tietojen haku epäonnistui.',
    retry: 'Yritä uudelleen',
    here: 'Tässä sijainnissa',
    tapHint: 'Valitse sijainti kartalta',
    period_: 'Voimassa',
    hours: 'Työaika',
    nightWork: 'Sisältää yötyötä',
    applicant: 'Ilmoittaja',
    authority: 'Päättäjä',
    decided: 'Päätetty',
    openDecision: 'Avaa päätös',
    categories: 'Melun tyyppi',
    blasting: 'Louhinta ja räjäytys',
    crushing: 'Murskaus ja iskuvasarointi',
    piling: 'Paalutus ja pontitus',
    drilling: 'Poraus',
    demolition: 'Purku ja saneeraus',
    rail: 'Rata- ja kiskotyö',
    marine: 'Vesirakentaminen',
    earthworks: 'Maa- ja katutyöt',
    event: 'Tapahtumat ja konsertit',
    other: 'Muu',
    quickRange: 'Pikavalinnat',
    more: 'muuta',
    approximate: 'Sijainti on likimääräinen',
    unlocated: 'Ilman sijaintia',
    unlocatedBody: 'Näiden ilmoitusten sijaintia ei voitu tunnistaa päätöstekstistä.',
    locate: 'Näytä sijaintini',
    layers: 'Suodata',
    updated: 'Tiedot päivitetty',
    info: 'Tietoa palvelusta',
    disclaimer: 'Tiedot on poimittu automaattisesti Helsingin kaupungin päätösteksteistä. Ajat ja sijainnit voivat olla epätarkkoja — tarkista aina alkuperäinen päätös.',
    sources: 'Lähde: Helsingin kaupungin päätökset ja avoin paikkatieto.',
  },
  en: {
    appName: 'MELU',
    region: 'Helsinki',
    period: 'Period',
    from: 'From',
    to: 'To',
    presetWeek: 'Next 7 days',
    presetToday: 'Today',
    presetMonth: 'Next 30 days',
    presetYear: 'This year',
    custom: 'Custom period',
    apply: 'Show period',
    close: 'Close',
    noticeCount: 'noise notices',
    noticeCountOne: 'noise notice',
    empty: 'No noise notices in the selected period.',
    emptyHint: 'Try a longer period.',
    loading: 'Loading noise notices…',
    loadError: 'Could not load the data.',
    retry: 'Try again',
    here: 'At this location',
    tapHint: 'Choose a location on the map',
    period_: 'Valid',
    hours: 'Working hours',
    nightWork: 'Includes night work',
    applicant: 'Applicant',
    authority: 'Decided by',
    decided: 'Decision date',
    openDecision: 'Open the decision',
    categories: 'Type of noise',
    blasting: 'Blasting',
    crushing: 'Crushing and hammering',
    piling: 'Piling and sheet piling',
    drilling: 'Drilling',
    demolition: 'Demolition and renovation',
    rail: 'Track and rail work',
    marine: 'Marine construction',
    earthworks: 'Earthworks and street works',
    event: 'Events and concerts',
    other: 'Other',
    quickRange: 'Quick ranges',
    more: 'more',
    approximate: 'Location is approximate',
    unlocated: 'Without a location',
    unlocatedBody: 'No location could be identified in these decision texts.',
    locate: 'Show my location',
    layers: 'Filter',
    updated: 'Data updated',
    info: 'About this service',
    disclaimer: 'Details are extracted automatically from City of Helsinki decision texts. Times and locations may be imprecise — always check the original decision.',
    sources: 'Source: City of Helsinki decisions and open geospatial data.',
  },
};

/* ---------------------------------------------------------------- data load */

async function loadJson(file) {
  const response = await fetch(`${DATA_BASE}${file}`, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

function useNoticeData(range) {
  const [manifest, setManifest] = useState(null);
  const [notices, setNotices] = useState(() => new Map());
  const [status, setStatus] = useState('loading');
  const loaded = useRef(new Set());
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const storage = browserStorage();
    (async () => {
      setStatus('loading');
      try {
        // The manifest is 3 kB and changes daily, so it is always fetched fresh;
        // the cached copy is only a fallback for an offline or failed load.
        let fresh = null;
        try {
          fresh = await loadJson('index.json');
        } catch {
          fresh = readJsonCache(storage, 'manifest', MANIFEST_MAX_AGE);
        }
        if (!isManifestUsable(fresh)) throw new Error('Unusable manifest');
        writeJsonCache(storage, 'manifest', fresh);
        const current = await loadJson('notices-current.json');
        if (cancelled) return;
        loaded.current = new Set(['current']);
        setManifest(fresh);
        setNotices(mergeNotices(new Map(), current.notices || []));
        setStatus('ready');
      } catch {
        if (!cancelled) setStatus('error');
      }
    })();
    return () => { cancelled = true; };
  }, [reloadToken]);

  // Year chunks arrive only when the chosen period actually reaches into them.
  // Editing the start date before the end date briefly widens the range across
  // every year in between, so the fetch waits for the range to settle.
  useEffect(() => {
    if (!manifest) return undefined;
    const missing = chunkKeysForRange(range, manifest).filter((key) => !loaded.current.has(key));
    if (!missing.length) return undefined;
    let cancelled = false;
    const storage = browserStorage();
    const timer = setTimeout(async () => {
      for (const key of missing) {
        const entry = manifest.chunks.find((chunk) => chunk.key === key);
        if (!entry || loaded.current.has(key)) continue;
        loaded.current.add(key);
        try {
          // Keyed by content hash, so a year that did not change is never refetched.
          const cacheKey = `chunk:${key}:${entry.hash || 'x'}`;
          const cached = readJsonCache(storage, cacheKey, CHUNK_MAX_AGE);
          const chunk = cached || await loadJson(entry.file);
          if (!cached) writeJsonCache(storage, cacheKey, chunk);
          if (cancelled) return;
          setNotices((previous) => mergeNotices(previous, chunk.notices || []));
        } catch {
          loaded.current.delete(key);
        }
      }
    }, RANGE_SETTLE_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [manifest, range.from, range.to]);

  return { manifest, notices, status, reload: () => setReloadToken((token) => token + 1) };
}

/* ------------------------------------------------------------------- markers */

function markerIcon(group, locale, text) {
  const category = noticeCategories(group.notices[0] || {})[0];
  const colour = CATEGORY_COLOURS[category] || CATEGORY_COLOURS.other;
  const imprecise = IMPRECISE.has(group.location.precision);
  const count = group.notices.length;
  return L.divIcon({
    className: 'melu-marker-wrap',
    html: `<span class="melu-marker${imprecise ? ' imprecise' : ''}" style="--dot:${colour}" title="${text}">${count > 1 ? count : ''}</span>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
}

/* ----------------------------------------------------------------- the app */

// Editing a custom range one field at a time passes through an intermediate range
// that can span a decade, which would pull down every year chunk in between. The
// draft is therefore only applied on request, never on each keystroke.
export function normaliseRange(draft) {
  return draft.from <= draft.to ? { ...draft } : { from: draft.to, to: draft.from };
}

export function rangePresets(t, today = isoToday()) {
  return [
    { key: 'today', label: t.presetToday, from: today, to: today },
    { key: 'week', label: t.presetWeek, from: today, to: addDays(today, 6) },
    { key: 'month', label: t.presetMonth, from: today, to: addDays(today, 29) },
    { key: 'year', label: t.presetYear, from: `${today.slice(0, 4)}-01-01`, to: `${today.slice(0, 4)}-12-31` },
  ];
}

export function activePresetKey(range, presets) {
  return presets.find((preset) => preset.from === range.from && preset.to === range.to)?.key || null;
}

function PeriodControl({ range, setRange, t, locale }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(range);
  const today = isoToday();

  useEffect(() => { if (open) setDraft(range); }, [open, range.from, range.to]);

  const apply = () => {
    setRange(normaliseRange(draft));
    setOpen(false);
  };
  const presets = rangePresets(t, today);
  const summary = range.from === range.to
    ? formatDate(range.from, locale)
    : `${formatDate(range.from, locale)} – ${formatDate(range.to, locale)}`;

  return (
    <div className="period-wrap">
      <button type="button" className="period-control" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <CalendarClock size={17} />
        <span>
          <small>{t.period}</small>
          <strong>{summary}</strong>
        </span>
        <ChevronDown size={15} />
      </button>
      {open && (
        <div className="period-popover">
          <div className="popover-head">
            <strong>{t.period}</strong>
            <button type="button" aria-label={t.close} onClick={() => setOpen(false)}><X size={15} /></button>
          </div>
          <div className="preset-grid">
            {presets.map((preset) => (
              <button
                key={preset.key}
                type="button"
                className={activePresetKey(range, presets) === preset.key ? 'active' : ''}
                onClick={() => { setRange({ from: preset.from, to: preset.to }); setOpen(false); }}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <div className="date-fields">
            <label>
              <span>{t.from}</span>
              <input
                type="date"
                value={draft.from}
                onChange={(event) => setDraft({ ...draft, from: event.target.value || today })}
              />
            </label>
            <label>
              <span>{t.to}</span>
              <input
                type="date"
                value={draft.to}
                onChange={(event) => setDraft({ ...draft, to: event.target.value || today })}
              />
            </label>
          </div>
          <button type="button" className="apply" onClick={apply}>{t.apply}</button>
        </div>
      )}
    </div>
  );
}

function NoticeCard({ notice, t, locale, label }) {
  const hours = displayHours(notice.hours);
  const categories = noticeCategories(notice);
  return (
    <article className="notice-card">
      <header>
        <span className="category-dot" style={{ background: CATEGORY_COLOURS[categories[0]] }} />
        <h3>{notice.activity || notice.title}</h3>
      </header>
      {label && <p className="notice-address">{label}</p>}
      <p className="category-chips">
        {categories.map((category) => (
          <span key={category} style={{ '--chip': CATEGORY_COLOURS[category] }}>{t[category]}</span>
        ))}
      </p>
      <dl>
        <div>
          <dt>{t.period_}</dt>
          <dd>{formatPeriod(notice, locale)}</dd>
        </div>
        {hours.length > 0 && (
          <div>
            <dt>{t.hours}</dt>
            <dd>{hours.map((window) => `${window.from}–${window.to}`).join(', ')}</dd>
          </div>
        )}
        {notice.applicant && (
          <div>
            <dt>{t.applicant}</dt>
            <dd>{notice.applicant}</dd>
          </div>
        )}
      </dl>
      {notice.nightWork && <p className="night"><Moon size={12} /> {t.nightWork}</p>}
      <footer>
        <span>{t.decided} {formatDate(notice.decisionDate, locale)}</span>
        {notice.url && (
          <a href={notice.url} target="_blank" rel="noreferrer">
            {t.openDecision} <ExternalLink size={12} />
          </a>
        )}
      </footer>
    </article>
  );
}

function App() {
  const [locale, setLocale] = useState('fi');
  const [range, setRange] = useState(() => defaultRange());
  const [selectedKey, setSelectedKey] = useState(null);
  const [hidden, setHidden] = useState(() => new Set());
  const [showFilters, setShowFilters] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [showUnlocated, setShowUnlocated] = useState(false);
  const t = copy[locale];

  const { manifest, notices, status, reload } = useNoticeData(range);
  const mapRef = useRef(null);
  const mapNode = useRef(null);
  const markerLayer = useRef(null);

  const inRange = useMemo(
    () => [...notices.values()].filter((notice) => noticeOverlapsRange(notice, range)),
    [notices, range],
  );
  const visible = useMemo(() => inRange.filter((notice) => matchesFilter(notice, hidden)), [inRange, hidden]);
  const groups = useMemo(() => groupByLocation(visible), [visible]);
  const unlocated = useMemo(() => unlocatedNotices(visible), [visible]);
  const counts = useMemo(() => categoryCounts(inRange), [inRange]);
  const legend = useMemo(() => legendCategories(visible, hidden), [visible, hidden]);
  const presets = useMemo(() => rangePresets(t), [t]);
  const activePreset = activePresetKey(range, presets);
  const selected = groups.find((group) => group.key === selectedKey) || null;

  useEffect(() => {
    if (mapRef.current || !mapNode.current) return;
    const map = L.map(mapNode.current, { center: HELSINKI, zoom: DEFAULT_MAP_ZOOM, zoomControl: true, attributionControl: true });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      attribution: '© OpenStreetMap, © CARTO',
      maxZoom: 19,
    }).addTo(map);
    markerLayer.current = L.layerGroup().addTo(map);
    mapRef.current = map;
  }, []);

  useEffect(() => {
    const layer = markerLayer.current;
    if (!layer) return;
    layer.clearLayers();
    for (const group of groups) {
      const marker = L.marker([group.location.lat, group.location.lon], {
        icon: markerIcon(group, locale, group.location.label || ''),
        keyboard: true,
        alt: group.location.label || '',
      });
      marker.on('click', () => setSelectedKey(group.key));
      layer.addLayer(marker);
    }
  }, [groups, locale]);

  useEffect(() => {
    if (selectedKey && !groups.some((group) => group.key === selectedKey)) setSelectedKey(null);
  }, [groups, selectedKey]);

  const locateMe = useCallback(() => {
    if (!navigator.geolocation || !mapRef.current) return;
    navigator.geolocation.getCurrentPosition(
      (position) => mapRef.current.setView([position.coords.latitude, position.coords.longitude], 14),
      () => {},
      { enableHighAccuracy: false, timeout: 8000 },
    );
  }, []);

  const toggleCategory = (category) => setHidden((previous) => {
    const next = new Set(previous);
    if (next.has(category)) next.delete(category); else next.add(category);
    return next;
  });

  const total = visible.length;

  return (
    <div className="app-shell">
      <div ref={mapNode} className="map" />

      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">M</span>
          <div>
            <strong>{t.appName}</strong>
            <small>{t.region}</small>
          </div>
        </div>
        <PeriodControl range={range} setRange={setRange} t={t} locale={locale} />
        <div className="top-actions">
          <button type="button" className="icon-button" title={t.layers} aria-label={t.layers} onClick={() => setShowFilters((value) => !value)}>
            <Layers3 size={17} />
          </button>
          <button type="button" className="icon-button" title={t.locate} aria-label={t.locate} onClick={locateMe}>
            <LocateFixed size={17} />
          </button>
          <button type="button" className="icon-button" title={t.info} aria-label={t.info} onClick={() => setShowInfo(true)}>
            <Info size={17} />
          </button>
          <button type="button" className="language" onClick={() => setLocale(locale === 'fi' ? 'en' : 'fi')}>
            {locale === 'fi' ? 'EN' : 'FI'}
          </button>
        </div>
      </header>

      <nav className="quick-ranges" aria-label={t.quickRange}>
        {presets.map((preset) => (
          <button
            key={preset.key}
            type="button"
            className={activePreset === preset.key ? 'active' : ''}
            onClick={() => setRange({ from: preset.from, to: preset.to })}
          >
            {preset.label}
          </button>
        ))}
      </nav>

      {showFilters && (
        <div className="filter-popover">
          <p className="popover-title">{t.categories}</p>
          {CATEGORY_ORDER.map((category) => (
            <label key={category}>
              <input type="checkbox" checked={!hidden.has(category)} onChange={() => toggleCategory(category)} />
              <i className="swatch" style={{ background: CATEGORY_COLOURS[category] }} />
              <span>{t[category]}</span>
              <b>{counts.get(category) || 0}</b>
            </label>
          ))}
        </div>
      )}

      <aside className="panel">
        {status === 'loading' && <div className="card message">{t.loading}</div>}
        {status === 'error' && (
          <div className="card message">
            <p>{t.loadError}</p>
            <button type="button" className="retry" onClick={reload}><RefreshCw size={13} /> {t.retry}</button>
          </div>
        )}
        {status === 'ready' && !selected && (
          <div className="card summary">
            <p className="eyebrow">{t.period}</p>
            <h2>{total} <small>{total === 1 ? t.noticeCountOne : t.noticeCount}</small></h2>
            {total === 0 ? (
              <p className="muted">{t.empty} {t.emptyHint}</p>
            ) : (
              <p className="muted"><MapPin size={12} /> {t.tapHint}</p>
            )}
            {unlocated.length > 0 && (
              <button type="button" className="unlocated-toggle" onClick={() => setShowUnlocated((value) => !value)}>
                {unlocated.length} · {t.unlocated}
              </button>
            )}
            {showUnlocated && (
              <div className="unlocated-list">
                <p className="muted small">{t.unlocatedBody}</p>
                {unlocated.map((notice) => <NoticeCard key={notice.id} notice={notice} t={t} locale={locale} />)}
              </div>
            )}
          </div>
        )}
        {status === 'ready' && selected && (
          <div className="card">
            <button type="button" className="panel-close" aria-label={t.close} onClick={() => setSelectedKey(null)}><X size={16} /></button>
            <p className="eyebrow">{t.here}</p>
            <h2 className="place-title">{selected.location.label || t.here}</h2>
            {selected.location.district && selected.location.label !== selected.location.district && (
              <p className="muted small">{selected.location.district}</p>
            )}
            {IMPRECISE.has(selected.location.precision) && (
              <p className="approximate"><AlertTriangle size={12} /> {t.approximate}</p>
            )}
            <div className="notice-list">
              {selected.notices.map((notice) => {
                const label = noticeLabelAt(notice, selected.key);
                return (
                  <NoticeCard
                    key={notice.id}
                    notice={notice}
                    t={t}
                    locale={locale}
                    label={label && label !== selected.location.label ? label : null}
                  />
                );
              })}
            </div>
          </div>
        )}
      </aside>

      {legend.shown.length > 0 && (
        <div className="map-legend">
          {legend.shown.map((category) => (
            <span key={category}><i style={{ background: CATEGORY_COLOURS[category] }} />{t[category]}</span>
          ))}
          {legend.overflow > 0 && <span className="legend-more">+{legend.overflow} {t.more}</span>}
        </div>
      )}

      {showInfo && (
        <div className="info-sheet">
          <button type="button" className="panel-close" aria-label={t.close} onClick={() => setShowInfo(false)}><X size={16} /></button>
          <h2>{t.info}</h2>
          <p>{t.disclaimer}</p>
          <p className="muted small">{t.sources}</p>
          {manifest && <p className="muted small">{t.updated} {formatDate(manifest.generatedAt.slice(0, 10), locale)} · {manifest.totalNotices}</p>}
        </div>
      )}

      <footer className="disclaimer">
        <AlertTriangle size={15} />
        <span>{t.disclaimer}</span>
      </footer>
    </div>
  );
}

const styles = `
  :root{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;--paper:#fbfaf7;--ink:#19201c;--muted:#68716b;--line:rgba(25,32,28,.11);--blue:#2457d6;color:var(--ink);background:#dfe3df;color-scheme:light;font-synthesis:none}
  *{box-sizing:border-box}
  html,body,#root{margin:0;width:100%;height:100%;overflow:hidden}
  button{font:inherit;color:inherit}
  .app-shell{position:relative;width:100%;height:100%;background:#dfe3df}
  .map{position:absolute;inset:0;z-index:0}
  .leaflet-container{font-family:inherit;background:#dfe3df}
  .leaflet-control-attribution{font-size:8px!important;background:rgba(251,250,247,.78)!important;color:#6f7771!important}
  .leaflet-control-zoom{border:0!important;box-shadow:0 8px 30px rgba(18,27,22,.14)!important;margin:0 18px 96px 0!important}
  .leaflet-control-zoom a{border:0!important;color:#222!important;background:#faf9f5!important}

  .topbar{position:absolute;z-index:600;left:50%;top:18px;width:min(660px,calc(100% - 36px));height:58px;display:flex;align-items:center;gap:10px;padding:7px 8px;background:rgba(251,250,247,.93);border:1px solid rgba(255,255,255,.78);border-radius:17px;box-shadow:0 8px 32px rgba(28,38,32,.12);backdrop-filter:blur(20px);transform:translateX(-50%)}
  .brand{display:flex;align-items:center;gap:9px;flex:0 0 auto;padding-right:5px}
  .brand-mark{display:grid;place-items:center;width:36px;height:36px;border-radius:11px;background:#1d2923;color:#fff;font-size:19px;font-weight:800}
  .brand div{display:flex;flex-direction:column}
  .brand strong{font-size:13px;line-height:1;letter-spacing:.11em}
  .brand small{margin-top:4px;color:#767a76;font-size:8px;font-weight:600;letter-spacing:.1em;text-transform:uppercase}

  .period-wrap{position:relative;flex:1;min-width:0}
  .period-control{width:100%;height:42px;display:flex;align-items:center;gap:9px;padding:0 11px;border:0;border-radius:12px;background:#f0efe9;color:#47504a;text-align:left;cursor:pointer}
  .period-control>svg:first-child{flex:0 0 auto;color:var(--blue)}
  .period-control>svg:last-child{margin-left:auto;color:#7b837d;transition:transform .18s}
  .period-control[aria-expanded=true]>svg:last-child{transform:rotate(180deg)}
  .period-control>span{min-width:0;display:flex;flex-direction:column}
  .period-control small{color:#7a827c;font-size:7px;font-weight:750;letter-spacing:.08em;text-transform:uppercase}
  .period-control strong{margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}
  .period-popover{position:absolute;z-index:720;top:49px;left:50%;width:min(340px,calc(100vw - 20px));padding:15px;border:1px solid rgba(255,255,255,.9);border-radius:18px;background:rgba(251,250,247,.98);box-shadow:0 18px 54px rgba(22,31,26,.2);backdrop-filter:blur(22px);transform:translateX(-50%)}
  .popover-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
  .popover-head>strong{font-size:13px}
  .popover-head button{width:29px;height:29px;display:grid;place-items:center;border:0;border-radius:50%;background:#efeee9;cursor:pointer}
  .preset-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px}
  .preset-grid button{height:38px;border:0;border-radius:11px;background:#f0efe9;color:#47504a;font-size:11px;font-weight:650;cursor:pointer}
  .preset-grid button.active{background:#e7ecfa;color:var(--blue)}
  .date-fields{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:12px}
  .date-fields label{display:flex;flex-direction:column;gap:6px}
  .date-fields span{color:#737b75;font-size:8px;font-weight:750;letter-spacing:.07em;text-transform:uppercase}
  .date-fields input{height:40px;padding:0 10px;border:1px solid var(--line);border-radius:11px;background:#fff;color:var(--ink);font:700 12px inherit;outline:0}
  .apply{width:100%;height:40px;margin-top:11px;border:0;border-radius:11px;background:#1d2923;color:#fff;font-size:11px;font-weight:700;cursor:pointer}

  .top-actions{display:flex;align-items:center;gap:5px;flex:0 0 auto}
  .icon-button{width:40px;height:40px;display:grid;place-items:center;border:0;border-radius:12px;background:transparent;color:#515a54;cursor:pointer;transition:.18s}
  .icon-button:hover{background:#f0efe9;color:var(--blue)}
  .language{height:36px;padding:0 10px;border:0;border-radius:10px;background:transparent;color:#515a54;font-size:10px;font-weight:700;cursor:pointer}
  .language:hover{background:#f0efe9}

  .quick-ranges{position:absolute;z-index:590;left:50%;top:84px;display:flex;gap:6px;max-width:calc(100% - 36px);padding:5px;border:1px solid rgba(255,255,255,.7);border-radius:14px;background:rgba(251,250,247,.92);box-shadow:0 6px 22px rgba(28,38,32,.11);backdrop-filter:blur(16px);transform:translateX(-50%);overflow-x:auto;scrollbar-width:none}
  .quick-ranges::-webkit-scrollbar{display:none}
  .quick-ranges button{flex:0 0 auto;height:32px;padding:0 13px;border:0;border-radius:10px;background:transparent;color:#515a54;font-size:11px;font-weight:650;white-space:nowrap;cursor:pointer}
  .quick-ranges button:hover{background:#f0efe9}
  .quick-ranges button.active{background:#1d2923;color:#fbfaf7}

  .filter-popover{position:absolute;z-index:620;right:calc(50% - 330px);top:126px;width:266px;padding:9px;border:1px solid rgba(255,255,255,.8);border-radius:16px;background:rgba(251,250,247,.97);box-shadow:0 14px 42px rgba(25,34,29,.16);backdrop-filter:blur(20px)}
  .popover-title{margin:0;padding:7px 9px 9px;color:#6d726d;font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
  .filter-popover label{display:grid;grid-template-columns:14px 10px 1fr auto;align-items:center;gap:9px;padding:9px;border-radius:10px;font-size:11px;cursor:pointer}
  .filter-popover label:hover{background:#f0efe9}
  .filter-popover .swatch{width:9px;height:9px;border-radius:3px}
  .filter-popover b{color:#7a827c;font-size:10px}

  .panel{position:absolute;z-index:500;left:18px;top:136px;bottom:96px;width:372px;overflow:auto;scrollbar-width:none}
  .panel::-webkit-scrollbar{display:none}
  .card{position:relative;padding:21px 20px 16px;background:rgba(251,250,247,.98);border:1px solid rgba(255,255,255,.88);border-radius:20px;box-shadow:0 16px 46px rgba(24,33,28,.16);backdrop-filter:blur(22px)}
  .card.message{display:flex;flex-direction:column;gap:11px;color:var(--muted);font-size:12px}
  .panel-close{position:absolute;right:12px;top:11px;width:32px;height:32px;display:grid;place-items:center;border:0;border-radius:50%;background:transparent;color:var(--muted);cursor:pointer}
  .eyebrow{margin:0;color:#7a817c;font-size:8px;font-weight:700;letter-spacing:.1em;text-transform:uppercase}
  .summary h2{margin:11px 0 6px;font-size:34px;letter-spacing:-.04em}
  .summary h2 small{font-size:12px;font-weight:600;letter-spacing:0;color:#777b77}
  .place-title{margin:10px 0 4px;font-size:24px;letter-spacing:-.03em}
  .muted{display:flex;align-items:center;gap:6px;margin:6px 0 0;color:var(--muted);font-size:11px;line-height:1.5}
  .muted.small{font-size:9px}
  .approximate{display:flex;align-items:center;gap:6px;margin:10px 0 0;padding:8px 9px;border-radius:9px;background:#f4eee2;color:#8a6420;font-size:9px}
  .retry{display:inline-flex;align-items:center;gap:7px;height:36px;padding:0 13px;border:0;border-radius:10px;background:#1d2923;color:#fff;font-size:11px;font-weight:650;cursor:pointer}
  .unlocated-toggle{margin-top:13px;height:34px;padding:0 12px;border:1px solid var(--line);border-radius:10px;background:transparent;color:#515a54;font-size:10px;font-weight:650;cursor:pointer}
  .unlocated-list{margin-top:11px}

  .notice-list{margin-top:13px}
  .notice-card{padding:13px 0;border-top:1px solid var(--line)}
  .notice-card header{display:grid;grid-template-columns:9px 1fr;align-items:baseline;gap:9px}
  .category-dot{width:9px;height:9px;border-radius:50%}
  .notice-card h3{margin:0;font-size:13px;line-height:1.35;letter-spacing:-.01em}
  .notice-address{margin:5px 0 0 18px;color:var(--muted);font-size:9px;font-weight:650}
  .category-chips{display:flex;flex-wrap:wrap;gap:5px;margin:8px 0 0 18px}
  .category-chips span{padding:3px 7px;border-radius:6px;background:color-mix(in srgb, var(--chip) 13%, transparent);color:var(--chip);font-size:8px;font-weight:750;letter-spacing:.02em}
  .notice-card dl{display:flex;flex-wrap:wrap;gap:7px;margin:10px 0 0}
  .notice-card dl div{flex:1 1 auto;min-width:96px;padding:8px 10px;border-radius:10px;background:#f0efe9}
  .notice-card dt{margin:0;color:#7a827c;font-size:7px;font-weight:750;letter-spacing:.07em;text-transform:uppercase}
  .notice-card dd{margin:3px 0 0;font-size:11px;font-weight:650}
  .notice-card .night{display:flex;align-items:center;gap:6px;margin:9px 0 0;color:#5b4a86;font-size:9px;font-weight:650}
  .notice-card footer{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:10px;color:#8d918d;font-size:8px}
  .notice-card footer a{display:inline-flex;align-items:center;gap:5px;color:var(--blue);font-size:9px;font-weight:700;text-decoration:none}

  .map-legend{position:absolute;z-index:440;left:18px;bottom:74px;display:flex;flex-wrap:wrap;align-items:center;gap:11px;max-width:372px;padding:8px 11px;border:1px solid rgba(255,255,255,.76);border-radius:16px;background:rgba(251,250,247,.88);box-shadow:0 7px 24px rgba(25,34,29,.08);backdrop-filter:blur(14px);color:#5d665f}
  .map-legend span{display:flex;align-items:center;gap:5px;font-size:8px;font-weight:700;white-space:nowrap}
  .map-legend .legend-more{color:#8b938c}
  .map-legend i{width:8px;height:8px;border-radius:50%}

  .info-sheet{position:absolute;z-index:700;left:50%;top:50%;width:min(440px,calc(100% - 36px));padding:24px;border-radius:20px;background:rgba(251,250,247,.99);box-shadow:0 22px 60px rgba(22,31,26,.24);transform:translate(-50%,-50%)}
  .info-sheet h2{margin:0 0 10px;font-size:19px}
  .info-sheet p{margin:0 0 8px;color:var(--muted);font-size:11px;line-height:1.6}

  .disclaimer{position:absolute;z-index:600;left:18px;right:18px;bottom:16px;display:flex;align-items:center;gap:10px;padding:10px 14px;background:rgba(26,31,28,.94);border-radius:12px;color:#f3f1e9;box-shadow:0 8px 30px rgba(16,21,18,.22);backdrop-filter:blur(12px)}
  .disclaimer>svg{flex:0 0 auto;color:#f2b64b}
  .disclaimer span{font-size:9px;line-height:1.45}

  .melu-marker{display:grid;place-items:center;width:26px;height:26px;border:2.5px solid #fbfaf7;border-radius:50%;background:var(--dot);color:#fff;font-size:10px;font-weight:800;box-shadow:0 4px 12px rgba(18,26,22,.3)}
  /* Approximate points read as hollow, so a district centroid is never mistaken
     for a surveyed address. */
  .melu-marker.imprecise{border-color:var(--dot);background:#fbfaf7;color:var(--dot);box-shadow:0 3px 9px rgba(18,26,22,.2)}

  /* Below this the topbar cannot hold the date and five controls at once; the
     quick-range row already shows the selected period, so the locate button goes. */
  @media(max-width:430px){
    .top-actions .icon-button:nth-of-type(2){display:none}
  }

  @media(max-width:820px){
    .topbar{left:10px;right:10px;top:10px;width:auto;height:54px;gap:6px;transform:none}
    .brand div{display:none}
    .brand{padding-right:0}
    /* The date summary alone is legible at this width; the field label is not. */
    .period-control{gap:7px;padding:0 9px}
    .period-control small{display:none}
    .period-control strong{font-size:12px}
    .icon-button{width:34px;height:34px;border-radius:10px}
    .language{height:32px;padding:0 7px}
    .top-actions{gap:1px}
    .quick-ranges{left:10px;right:10px;top:72px;max-width:none;justify-content:flex-start;transform:none}
    .period-wrap{min-width:104px}
    .filter-popover{right:10px;top:118px}
    .panel{left:10px;right:10px;top:auto;bottom:104px;width:auto;max-height:46vh}
    .map-legend{display:none}
    .disclaimer{left:10px;right:10px;bottom:10px;padding:8px 10px}
    .disclaimer span{font-size:8px}
    .leaflet-control-zoom{margin:0 10px 150px 0!important}
  }
`;

if (typeof document !== 'undefined' && document.getElementById('root')) {
  const sheet = document.createElement('style');
  sheet.textContent = styles;
  document.head.appendChild(sheet);
  createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);
}

export default App;
