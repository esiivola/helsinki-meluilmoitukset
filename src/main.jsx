import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {
  AlertTriangle, Bell, CalendarClock, Check, ChevronDown, ExternalLink, Info,
  LocateFixed, MapPin, Moon, Pencil, RefreshCw, Trash2, X,
} from 'lucide-react';
import {
  boundsToPolygon, clearAllGuards, clearGuard, createGuard, acknowledgeNotices, nextGuardId,
  pendingByGuard, polygonAreaKm2, readGuards, totalPending, writeGuards,
} from './guards.js';

const HELSINKI = [60.16986, 24.93838];
export const DEFAULT_MAP_ZOOM = 12;
export const DEFAULT_RANGE_DAYS = 7;
const DATA_BASE = `${import.meta.env.BASE_URL}data/`;
const CACHE_PREFIX = 'helsinki-melu:v1:';
const MANIFEST_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const CHUNK_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
const RANGE_SETTLE_MS = 400;
const MIN_AREA_POINTS = 3;

const CATEGORY_ORDER = ['event', 'construction', 'other'];
// Slate, ochre and warm grey. The palette is deliberately free of traffic-light
// meaning: a concert is not "good" and a demolition site is not "bad", they are
// simply different activities. Blue against ochre also stays separable for the
// common forms of colour vision deficiency.
const CATEGORY_COLOURS = {
  construction: '#33566f',
  event: '#9d7b2f',
  other: '#8b918d',
};
const IMPRECISE = new Set(['district', 'street', 'area']);

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

// A notice without a stated period still has a decision date, so it can be placed in time.
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

/* -------------------------------------------------------------- presentation */

export function formatDate(iso, locale) {
  if (!iso) return '';
  const [year, month, day] = iso.split('-');
  return locale === 'en' ? `${day}.${month}.${year}` : `${Number(day)}.${Number(month)}.${year}`;
}

// Finnish drops the repeated year in a range: 9.8.-15.8.2026 rather than
// 9.8.2026-15.8.2026. Shorter and more idiomatic, which the narrow topbar needs.
export function formatRange(range, locale) {
  if (range.from === range.to) return formatDate(range.from, locale);
  const sameYear = range.from.slice(0, 4) === range.to.slice(0, 4);
  const start = sameYear
    ? formatDate(range.from, locale).replace(/\.?\d{4}$/, '.')
    : formatDate(range.from, locale);
  return `${start}\u2013${formatDate(range.to, locale)}`;
}

export function formatPeriod(notice, locale) {
  const span = noticeSpan(notice);
  if (!span) return '';
  if (span.start === span.end) return formatDate(span.start, locale);
  return `${formatDate(span.start, locale)}–${formatDate(span.end, locale)}`;
}

// The permitted hours are what a resident needs. A blanket night ban is standard
// wording in every decision and is only worth showing when nothing else was found.
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

// Earliest first, so a reader looking at a busy corner sees what starts soonest
// at the top rather than whatever order the chunks happened to load in.
export function byStartDate(a, b) {
  const spanA = noticeSpan(a);
  const spanB = noticeSpan(b);
  return (spanA?.start || '').localeCompare(spanB?.start || '')
    || (spanA?.end || '').localeCompare(spanB?.end || '')
    || (a.title || '').localeCompare(b.title || '');
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
  for (const group of groups.values()) group.notices.sort(byStartDate);
  return [...groups.values()].sort((a, b) => b.notices.length - a.notices.length);
}

// Corner buildings share one register point under two street addresses, so a
// group heading can name a street the individual notice never mentions.
export function noticeLabelAt(notice, key) {
  const match = (notice.locations || []).find((location) => locationKey(location) === key);
  return match?.label || null;
}

export function unlocatedNotices(notices) {
  return notices.filter((notice) => !notice.locations?.length).sort(byStartDate);
}

export function noticeCategory(notice) {
  return CATEGORY_ORDER.includes(notice?.category) ? notice.category : 'other';
}

export function categoryCounts(notices) {
  const counts = new Map(CATEGORY_ORDER.map((category) => [category, 0]));
  for (const notice of notices) {
    counts.set(noticeCategory(notice), counts.get(noticeCategory(notice)) + 1);
  }
  return counts;
}

export function matchesFilter(notice, hidden) {
  return !hidden.has(noticeCategory(notice));
}

export function describeArea(polygon, t) {
  const km2 = polygonAreaKm2(polygon);
  const size = km2 < 1 ? `${Math.round(km2 * 100) / 100}` : `${Math.round(km2 * 10) / 10}`;
  return `${size} km², ${polygon.length} ${t.corners}`;
}

/* -------------------------------------------------------------------- copy */

// Wording follows the City of Helsinki and the Finnish Environment Institute:
// a meluilmoitus is an "ilmoitus melua tai tärinää aiheuttavasta tilapäisestä
// toiminnasta" under section 118 of the Environmental Protection Act, and the
// authority answers it with a "päätös" carrying "määräyksiä".
const copy = {
  fi: {
    appName: 'MELU',
    region: 'Helsinki',
    skip: 'Siirry sisältöön',
    mapLabel: 'Kartta meluilmoituksista',
    period: 'Ajanjakso',
    from: 'Alkaa',
    to: 'Päättyy',
    presetToday: 'Tänään',
    presetWeek: '7 vuorokautta',
    presetMonth: '30 vuorokautta',
    presetYear: 'Tämä vuosi',
    apply: 'Näytä ajanjakso',
    quickRange: 'Ajanjakson pikavalinnat',
    close: 'Sulje',
    noticeCount: 'meluilmoitusta',
    noticeCountOne: 'meluilmoitus',
    resultSummary: 'Valitulla ajanjaksolla on',
    empty: 'Valitulla ajanjaksolla ei ole meluilmoituksia.',
    emptyHint: 'Valitse pidempi ajanjakso.',
    loading: 'Haetaan meluilmoituksia.',
    loadError: 'Tietojen haku ei onnistunut.',
    retry: 'Yritä uudelleen',
    here: 'Tässä kohteessa',
    tapHint: 'Valitse kohde kartalta.',
    validity: 'Voimassa',
    hours: 'Sallittu työaika',
    nightWork: 'Sisältää yötyötä',
    applicant: 'Ilmoittaja',
    decided: 'Päätös annettu',
    openDecision: 'Avaa päätös',
    filters: 'Rajaa melun tyypin mukaan',
    customPeriod: 'Oma ajanjakso',
    approximateLegend: 'Vaalea ympyrä: sijainti on likimääräinen',
    fromPeriod: 'ajalta',
    editWatch: 'Muokkaa',
    saveChanges: 'Tallenna muutokset',
    typesHint: 'Jos et valitse yhtään tyyppiä, vahti seuraa niitä kaikkia.',
    categories: 'Melun tyyppi',
    construction: 'Rakentaminen',
    event: 'Yleisötilaisuudet',
    other: 'Muu toiminta',
    approximate: 'Sijainti on likimääräinen.',
    unlocated: 'Ilmoitukset ilman sijaintia',
    unlocatedCount: 'ilmoitusta ilman sijaintia',
    unlocatedBody: 'Näiden päätösten tekstistä ei tunnistettu sijaintia.',
    locate: 'Keskitä kartta sijaintiini',
    info: 'Tietoa palvelusta',
    infoLead: 'Palvelu kokoaa Helsingin kaupungin meluilmoituspäätökset kartalle.',
    infoBody: 'Meluilmoitus on ympäristönsuojelulain 118 §:n mukainen ilmoitus tilapäisestä toiminnasta, joka aiheuttaa erityisen häiritsevää melua tai tärinää. Ilmoituksen käsittelee kaupunkiympäristön toimialan ympäristönsuojelu, joka antaa päätöksessä toimintaa koskevat määräykset.',
    infoAccuracy: 'Ajanjaksot, työajat ja sijainnit on poimittu päätösteksteistä automaattisesti. Ne voivat olla epätarkkoja tai puutteellisia. Alkuperäinen päätös ratkaisee.',
    infoPrivacy: 'Vahdit ja niiden alueet tallennetaan vain tämän selaimen muistiin. Palvelussa ei ole palvelinta, joka voisi ottaa tietoja vastaan.',
    sources: 'Lähteet',
    sourceDecisions: 'Helsingin kaupungin päätökset',
    sourceGeo: 'Helsingin kaupungin avoin paikkatieto: osoiteluettelo, nimistö ja aluejako',
    sourceMap: 'Taustakartta: OpenStreetMap ja CARTO',
    updated: 'Aineisto päivitetty',
    disclaimer: 'Tiedot on poimittu päätösteksteistä automaattisesti. Tarkista aina alkuperäinen päätös.',
    watches: 'Vahdit',
    watchesLabel: 'Vahdit ja uudet ilmoitukset',
    watchCount: 'uutta ilmoitusta',
    watchCountOne: 'uusi ilmoitus',
    watchEmpty: 'Et ole vielä luonut vahteja.',
    watchEmptyBody: 'Vahti seuraa valitsemaasi aluetta ja kertoo, kun alueelle tulee uusi meluilmoitus. Tiedot pysyvät selaimessasi.',
    addWatch: 'Luo vahti',
    drawArea: 'Piirrä alue kartalle',
    drawHint: 'Napauta kartalta alueen kulmat. Vähintään kolme kulmaa.',
    drawUseView: 'Käytä nykyistä karttanäkymää',
    drawUndo: 'Poista viimeisin kulma',
    drawFinish: 'Valmis',
    cancel: 'Peruuta',
    nameWatch: 'Vahdin nimi',
    namePlaceholder: 'Esimerkiksi Koti',
    typesWatched: 'Seurattavat melun tyypit',
    allTypes: 'Kaikki tyypit',
    saveWatch: 'Tallenna vahti',
    dismiss: 'Kuittaa',
    dismissAll: 'Kuittaa kaikki',
    dismissAllWatches: 'Kuittaa kaikkien vahtien ilmoitukset',
    removeWatch: 'Poista vahti',
    noNew: 'Ei uusia ilmoituksia.',
    corners: 'kulmaa',
    watchArea: 'Alue',
    guardLimit: 'Vahteja voi olla enintään',
  },
  en: {
    appName: 'MELU',
    region: 'Helsinki',
    skip: 'Skip to content',
    mapLabel: 'Map of noise notifications',
    period: 'Period',
    from: 'Starts',
    to: 'Ends',
    presetToday: 'Today',
    presetWeek: '7 days',
    presetMonth: '30 days',
    presetYear: 'This year',
    apply: 'Show period',
    quickRange: 'Period shortcuts',
    close: 'Close',
    noticeCount: 'noise notifications',
    noticeCountOne: 'noise notification',
    resultSummary: 'The selected period has',
    empty: 'No noise notifications in the selected period.',
    emptyHint: 'Choose a longer period.',
    loading: 'Loading noise notifications.',
    loadError: 'The data could not be loaded.',
    retry: 'Try again',
    here: 'At this site',
    tapHint: 'Choose a site on the map.',
    validity: 'Valid',
    hours: 'Permitted hours',
    nightWork: 'Includes night work',
    applicant: 'Notifier',
    decided: 'Decision issued',
    openDecision: 'Open the decision',
    filters: 'Filter by type of noise',
    customPeriod: 'Custom period',
    approximateLegend: 'Pale circle: the location is approximate',
    fromPeriod: 'from',
    editWatch: 'Edit',
    saveChanges: 'Save the changes',
    typesHint: 'If you choose no types, the watch follows all of them.',
    categories: 'Type of noise',
    construction: 'Construction',
    event: 'Public events',
    other: 'Other activity',
    approximate: 'The location is approximate.',
    unlocated: 'Notifications without a location',
    unlocatedCount: 'notifications without a location',
    unlocatedBody: 'No location could be identified in these decision texts.',
    locate: 'Centre the map on my location',
    info: 'About this service',
    infoLead: 'This service collects the City of Helsinki noise notification decisions onto a map.',
    infoBody: 'A noise notification is required under section 118 of the Environmental Protection Act for temporary activity that causes particularly disturbing noise or vibration. It is handled by environmental protection within the Urban Environment Division, whose decision sets the conditions for the activity.',
    infoAccuracy: 'Periods, working hours and locations are extracted from the decision texts automatically. They may be imprecise or incomplete. The original decision always governs.',
    infoPrivacy: 'Watches and their areas are stored only in this browser. The service has no server that could receive them.',
    sources: 'Sources',
    sourceDecisions: 'City of Helsinki decisions',
    sourceGeo: 'City of Helsinki open geospatial data: address register, place names and district division',
    sourceMap: 'Base map: OpenStreetMap and CARTO',
    updated: 'Data updated',
    disclaimer: 'Details are extracted from decision texts automatically. Always check the original decision.',
    watches: 'Watches',
    watchesLabel: 'Watches and new notifications',
    watchCount: 'new notifications',
    watchCountOne: 'new notification',
    watchEmpty: 'You have not created any watches yet.',
    watchEmptyBody: 'A watch follows an area you choose and tells you when a new noise notification appears there. Everything stays in your browser.',
    addWatch: 'Create a watch',
    drawArea: 'Draw an area on the map',
    drawHint: 'Tap the corners of the area on the map. At least three corners.',
    drawUseView: 'Use the current map view',
    drawUndo: 'Remove the last corner',
    drawFinish: 'Done',
    cancel: 'Cancel',
    nameWatch: 'Watch name',
    namePlaceholder: 'For example Home',
    typesWatched: 'Types of noise to follow',
    allTypes: 'All types',
    saveWatch: 'Save the watch',
    dismiss: 'Clear',
    dismissAll: 'Clear all',
    dismissAllWatches: 'Clear the notifications of every watch',
    removeWatch: 'Remove the watch',
    noNew: 'No new notifications.',
    corners: 'corners',
    watchArea: 'Area',
    guardLimit: 'The maximum number of watches is',
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
        // The manifest is small and changes daily, so it is always fetched fresh.
        // The cached copy is only a fallback for a failed or offline load.
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

  // Year chunks arrive only when the chosen period reaches into them. Editing the
  // start date before the end date briefly widens the range across every year in
  // between, so the fetch waits for the range to settle.
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

/* ------------------------------------------------------------------ markers */

function markerIcon(group) {
  const colour = CATEGORY_COLOURS[noticeCategory(group.notices[0])];
  const imprecise = IMPRECISE.has(group.location.precision);
  const count = group.notices.length;
  return L.divIcon({
    className: 'melu-marker-wrap',
    html: `<span class="melu-marker${imprecise ? ' imprecise' : ''}" style="--dot:${colour}">${count > 1 ? count : ''}</span>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
}

/* ----------------------------------------------------------- small elements */

function NoticeCard({ notice, t, locale, label, action }) {
  const hours = displayHours(notice.hours);
  return (
    <article className="notice-card">
      <h3>{notice.activity || notice.title}</h3>
      {label && <p className="notice-address">{label}</p>}
      <p className="category-chip">
        <span className="chip-dot" style={{ background: CATEGORY_COLOURS[noticeCategory(notice)] }} aria-hidden="true" />
        {t[noticeCategory(notice)]}
      </p>
      <dl>
        <div>
          <dt>{t.validity}</dt>
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
      {notice.nightWork && <p className="night"><Moon size={13} aria-hidden="true" /> {t.nightWork}</p>}
      <footer>
        <span>{t.decided} {formatDate(notice.decisionDate, locale)}</span>
        {notice.url && (
          <a href={notice.url} target="_blank" rel="noreferrer">
            {t.openDecision}
            <ExternalLink size={13} aria-hidden="true" />
          </a>
        )}
      </footer>
      {action}
    </article>
  );
}

// A dialog that closes on Escape and returns focus to whatever opened it.
function Overlay({ id, title, onClose, t, children, className = '' }) {
  const node = useRef(null);
  useEffect(() => {
    const opener = document.activeElement;
    node.current?.querySelector('h2')?.focus();
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, [onClose]);

  return (
    <div className={`overlay ${className}`} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} ref={node}>
      <div className="overlay-head">
        <h2 id={`${id}-title`} tabIndex={-1}>{title}</h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label={t.close}>
          <X size={18} aria-hidden="true" />
        </button>
      </div>
      {children}
    </div>
  );
}

function PeriodControl({ range, setRange, t, locale }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(range);
  const today = isoToday();

  useEffect(() => { if (open) setDraft(range); }, [open, range.from, range.to]);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const presets = rangePresets(t, today);
  const summary = formatRange(range, locale);

  return (
    <div className="period-wrap">
      <button
        type="button"
        className="period-control"
        aria-expanded={open}
        aria-controls="period-popover"
        onClick={() => setOpen((value) => !value)}
      >
        <CalendarClock size={18} aria-hidden="true" />
        <span>
          <small>{t.period}</small>
          <strong>{summary}</strong>
        </span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open && (
        <div className="period-popover" id="period-popover">
          <div className="preset-grid">
            {presets.map((preset) => (
              <button
                key={preset.key}
                type="button"
                aria-pressed={activePresetKey(range, presets) === preset.key}
                onClick={() => { setRange({ from: preset.from, to: preset.to }); setOpen(false); }}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <p className="popover-title">{t.customPeriod}</p>
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
          <button
            type="button"
            className="primary"
            onClick={() => { setRange(normaliseRange(draft)); setOpen(false); }}
          >
            {t.apply}
          </button>
        </div>
      )}
    </div>
  );
}

function CategoryPicker({ selected, toggle, t, counts, idPrefix }) {
  return (
    <ul className="category-picker">
      {CATEGORY_ORDER.map((category) => (
        <li key={category}>
          <label htmlFor={`${idPrefix}-${category}`}>
            <input
              id={`${idPrefix}-${category}`}
              type="checkbox"
              checked={selected(category)}
              onChange={() => toggle(category)}
            />
            <span className="chip-dot" style={{ background: CATEGORY_COLOURS[category] }} aria-hidden="true" />
            <span className="picker-label">{t[category]}</span>
            {counts && <span className="picker-count">{counts.get(category) || 0}</span>}
          </label>
        </li>
      ))}
    </ul>
  );
}

/* ----------------------------------------------------------------- the app */

function App() {
  const [locale, setLocale] = useState('fi');
  const [range, setRange] = useState(() => defaultRange());
  const [selectedKey, setSelectedKey] = useState(null);
  const [hidden, setHidden] = useState(() => new Set());
  const [panel, setPanel] = useState(null); // 'filters' | 'watches' | 'info'
  const [guards, setGuards] = useState(() => readGuards(browserStorage()));
  const [draft, setDraft] = useState(null); // { points, name, categories, closed, editing }
  const t = copy[locale];

  const { manifest, notices, status, reload } = useNoticeData(range);
  const mapRef = useRef(null);
  const mapNode = useRef(null);
  const markerLayer = useRef(null);
  const guardLayer = useRef(null);
  const draftLayer = useRef(null);

  const allNotices = useMemo(() => [...notices.values()], [notices]);
  const inRange = useMemo(
    () => allNotices.filter((notice) => noticeOverlapsRange(notice, range)),
    [allNotices, range],
  );
  const visible = useMemo(() => inRange.filter((notice) => matchesFilter(notice, hidden)), [inRange, hidden]);
  const groups = useMemo(() => groupByLocation(visible), [visible]);
  const unlocated = useMemo(() => unlocatedNotices(visible), [visible]);
  const counts = useMemo(() => categoryCounts(inRange), [inRange]);
  const presets = useMemo(() => rangePresets(t), [t]);
  const activePreset = activePresetKey(range, presets);
  const selected = groups.find((group) => group.key === selectedKey) || null;

  // Watches are evaluated against everything loaded rather than the chosen period.
  // The always-loaded current slice holds every recently decided notice, so a new
  // decision is caught regardless of which period the reader is looking at.
  const watchResults = useMemo(() => pendingByGuard(allNotices, guards), [allNotices, guards]);
  const pendingCount = useMemo(() => totalPending(allNotices, guards), [allNotices, guards]);

  useEffect(() => { document.documentElement.lang = locale; }, [locale]);

  const persist = useCallback((next) => {
    setGuards(next);
    writeGuards(browserStorage(), next);
  }, []);

  useEffect(() => {
    if (mapRef.current || !mapNode.current) return;
    const map = L.map(mapNode.current, {
      center: HELSINKI, zoom: DEFAULT_MAP_ZOOM, zoomControl: true, attributionControl: true,
    });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OpenStreetMap, &copy; CARTO',
      maxZoom: 19,
    }).addTo(map);
    guardLayer.current = L.layerGroup().addTo(map);
    draftLayer.current = L.layerGroup().addTo(map);
    markerLayer.current = L.layerGroup().addTo(map);
    mapRef.current = map;
  }, []);

  // Drawing: each map click adds a corner.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return undefined;
    const onClick = (event) => {
      if (!draft || draft.closed) return;
      setDraft((current) => ({
        ...current,
        points: [...current.points, [event.latlng.lat, event.latlng.lng]],
      }));
    };
    map.on('click', onClick);
    return () => { map.off('click', onClick); };
  }, [draft]);

  useEffect(() => {
    if (!draft || draft.closed) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') setDraft(null);
      if (event.key === 'Backspace' && draft.points.length) {
        event.preventDefault();
        setDraft((current) => ({ ...current, points: current.points.slice(0, -1) }));
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [draft]);

  useEffect(() => {
    const layer = draftLayer.current;
    if (!layer) return;
    layer.clearLayers();
    if (!draft?.points.length) return;
    if (draft.points.length >= MIN_AREA_POINTS) {
      layer.addLayer(L.polygon(draft.points, { color: '#2457d6', weight: 2, fillOpacity: 0.08, dashArray: '5 4' }));
    } else if (draft.points.length === 2) {
      layer.addLayer(L.polyline(draft.points, { color: '#2457d6', weight: 2, dashArray: '5 4' }));
    }
    for (const point of draft.points) {
      layer.addLayer(L.circleMarker(point, {
        radius: 5, color: '#2457d6', fillColor: '#fbfaf7', fillOpacity: 1, weight: 2,
      }));
    }
  }, [draft]);

  useEffect(() => {
    const layer = guardLayer.current;
    if (!layer) return;
    layer.clearLayers();
    if (panel !== 'watches') return;
    for (const guard of guards) {
      layer.addLayer(L.polygon(guard.polygon, {
        color: '#1d2923', weight: 1.5, fillOpacity: 0.05, interactive: false,
      }));
    }
  }, [guards, panel]);

  useEffect(() => {
    const layer = markerLayer.current;
    if (!layer) return;
    layer.clearLayers();
    for (const group of groups) {
      const label = `${group.location.label || ''} (${group.notices.length})`;
      const marker = L.marker([group.location.lat, group.location.lon], {
        icon: markerIcon(group),
        keyboard: true,
        title: label,
        alt: label,
      });
      marker.on('click', () => setSelectedKey(group.key));
      marker.on('keypress', (event) => {
        if (event.originalEvent.key === 'Enter') setSelectedKey(group.key);
      });
      layer.addLayer(marker);
    }
  }, [groups]);

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

  const toggleHidden = (category) => setHidden((previous) => {
    const next = new Set(previous);
    if (next.has(category)) next.delete(category); else next.add(category);
    return next;
  });

  const startDraw = () => {
    setPanel(null);
    setDraft({ points: [], name: '', categories: [], closed: false });
  };

  const useCurrentView = () => {
    const map = mapRef.current;
    if (!map) return;
    const bounds = map.getBounds();
    setDraft({
      points: boundsToPolygon({
        south: bounds.getSouth(), west: bounds.getWest(), north: bounds.getNorth(), east: bounds.getEast(),
      }),
      name: '',
      categories: [],
      closed: true,
    });
  };

  const saveDraft = () => {
    if (draft.editing) {
      persist(guards.map((guard) => (guard.id === draft.editing
        ? { ...guard, name: draft.name.trim(), categories: draft.categories }
        : guard)));
    } else {
      persist([...guards, createGuard({
        id: nextGuardId(guards),
        name: draft.name,
        polygon: draft.points,
        categories: draft.categories,
        notices: allNotices,
      })]);
    }
    setDraft(null);
    setPanel('watches');
  };

  const editGuard = (guard) => {
    setPanel(null);
    setDraft({
      points: guard.polygon,
      name: guard.name,
      categories: [...guard.categories],
      closed: true,
      editing: guard.id,
    });
  };

  const total = visible.length;
  const drawing = Boolean(draft) && !draft.closed;

  return (
    <div className="app-shell">
      <a className="skip-link" href="#results">{t.skip}</a>
      <div
        ref={mapNode}
        className={`map${drawing ? ' drawing' : ''}`}
        role="application"
        aria-label={t.mapLabel}
      />

      <header className="topbar">
        <div className="topbar-row">
          <PeriodControl range={range} setRange={setRange} t={t} locale={locale} />
          <div className="top-actions">
            <button
              type="button"
              className={`icon-button${pendingCount ? ' alert' : ''}`}
              aria-label={`${t.watchesLabel}: ${pendingCount}`}
              aria-expanded={panel === 'watches'}
              onClick={() => setPanel(panel === 'watches' ? null : 'watches')}
            >
              <Bell size={18} aria-hidden="true" />
              {pendingCount > 0 && <span className="badge">{pendingCount}</span>}
            </button>
            <button type="button" className="icon-button locate" aria-label={t.locate} onClick={locateMe}>
              <LocateFixed size={18} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="language"
              aria-label={locale === 'fi' ? 'FI, vaihda kieleksi englanti' : 'EN, switch the language to Finnish'}
              onClick={() => setLocale(locale === 'fi' ? 'en' : 'fi')}
            >
              {locale === 'fi' ? 'FI' : 'EN'}
            </button>
          </div>
        </div>
        <div className="topbar-row legend-row">
          <div className="legend" role="group" aria-label={t.filters}>
            {CATEGORY_ORDER.map((category) => (
              <button
                key={category}
                type="button"
                aria-pressed={!hidden.has(category)}
                onClick={() => toggleHidden(category)}
              >
                <span className="chip-dot" style={{ background: CATEGORY_COLOURS[category] }} aria-hidden="true" />
                {t[category]}
                <b>{counts.get(category) || 0}</b>
              </button>
            ))}
          </div>
          <p className="legend-note">
            <span className="chip-dot hollow" aria-hidden="true" />
            {t.approximateLegend}
          </p>
        </div>
      </header>

      <main className={`panel${panel ? ' behind' : ''}`} id="results">
        <p className="visually-hidden" aria-live="polite">
          {status === 'ready' ? `${t.resultSummary} ${total} ${total === 1 ? t.noticeCountOne : t.noticeCount}.` : t.loading}
        </p>

        {status === 'loading' && <div className="card message">{t.loading}</div>}
        {status === 'error' && (
          <div className="card message">
            <p>{t.loadError}</p>
            <button type="button" className="primary" onClick={reload}>
              <RefreshCw size={14} aria-hidden="true" /> {t.retry}
            </button>
          </div>
        )}

        {status === 'ready' && !selected && unlocated.length > 0 && (
          <details className="card unlocated">
            <summary>{`${unlocated.length} ${t.unlocatedCount}`}</summary>
            <p className="muted">{t.unlocatedBody}</p>
            {unlocated.map((notice) => (
              <NoticeCard key={notice.id} notice={notice} t={t} locale={locale} />
            ))}
          </details>
        )}

        {status === 'ready' && selected && (
          <div className="card">
            <button
              type="button"
              className="icon-button panel-close"
              aria-label={t.close}
              onClick={() => setSelectedKey(null)}
            >
              <X size={18} aria-hidden="true" />
            </button>
            <p className="eyebrow">{t.here}</p>
            <h1 className="place-title">{selected.location.label || t.here}</h1>
            {selected.location.district && selected.location.label !== selected.location.district && (
              <p className="muted">{selected.location.district}</p>
            )}
            {IMPRECISE.has(selected.location.precision) && (
              <p className="approximate">
                <AlertTriangle size={14} aria-hidden="true" />
                {' '}
                {t.approximate}
              </p>
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
            <p className="card-note">{t.disclaimer}</p>
          </div>
        )}
      </main>

      {panel === 'watches' && (
        <Overlay id="watches" title={t.watches} onClose={() => setPanel(null)} t={t} className="side">
          {guards.length === 0 ? (
            <div className="empty-watches">
              <p>{t.watchEmpty}</p>
              <p className="muted">{t.watchEmptyBody}</p>
            </div>
          ) : (
            <>
              {pendingCount > 0 && (
                <button
                  type="button"
                  className="ghost"
                  onClick={() => persist(clearAllGuards(guards, allNotices))}
                >
                  <Check size={14} aria-hidden="true" /> {t.dismissAllWatches}
                </button>
              )}
              <ul className="watch-list">
                {watchResults.map(({ guard, notices: pending }) => (
                  <li key={guard.id}>
                    <div className="watch-head">
                      <h3>{guard.name || guard.id}</h3>
                      <p className="muted">
                        {`${t.watchArea}: ${describeArea(guard.polygon, t)}`}
                        {guard.categories.length
                          ? ` · ${guard.categories.map((category) => t[category]).join(', ')}`
                          : ` · ${t.allTypes}`}
                      </p>
                      <p className={pending.length ? 'watch-count alert' : 'watch-count'}>
                        {pending.length
                          ? `${pending.length} ${pending.length === 1 ? t.watchCountOne : t.watchCount}`
                          : t.noNew}
                      </p>
                    </div>
                    {pending.map((notice) => (
                      <NoticeCard
                        key={notice.id}
                        notice={notice}
                        t={t}
                        locale={locale}
                        action={(
                          <button
                            type="button"
                            className="ghost small"
                            onClick={() => persist(guards.map((item) => (
                              item.id === guard.id ? acknowledgeNotices(item, [notice.id]) : item)))}
                          >
                            <Check size={13} aria-hidden="true" /> {t.dismiss}
                          </button>
                        )}
                      />
                    ))}
                    <div className="watch-actions">
                      <button type="button" className="ghost small" onClick={() => editGuard(guard)}>
                        <Pencil size={13} aria-hidden="true" /> {t.editWatch}
                      </button>
                      {pending.length > 0 && (
                        <button
                          type="button"
                          className="ghost small"
                          onClick={() => persist(guards.map((item) => (
                            item.id === guard.id ? clearGuard(item, allNotices) : item)))}
                        >
                          <Check size={13} aria-hidden="true" /> {t.dismissAll}
                        </button>
                      )}
                      <button
                        type="button"
                        className="ghost small danger"
                        onClick={() => persist(guards.filter((item) => item.id !== guard.id))}
                      >
                        <Trash2 size={13} aria-hidden="true" /> {t.removeWatch}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
          <button type="button" className="primary" onClick={startDraw}>
            <Pencil size={14} aria-hidden="true" /> {t.addWatch}
          </button>
        </Overlay>
      )}

      {panel === 'info' && (
        <Overlay id="info" title={t.info} onClose={() => setPanel(null)} t={t} className="centre">
          <p className="lead">{t.infoLead}</p>
          <p>{t.infoBody}</p>
          <p>{t.infoAccuracy}</p>
          <p>{t.infoPrivacy}</p>
          <h3>{t.sources}</h3>
          <ul className="source-list">
            <li><a href="https://paatokset.hel.fi/fi/asia?s=meluilmoitus" target="_blank" rel="noreferrer">{t.sourceDecisions}</a></li>
            <li>{t.sourceGeo}</li>
            <li>{t.sourceMap}</li>
          </ul>
          {manifest && (
            <p className="muted">
              {`${manifest.totalNotices} ${t.noticeCount}`}
              {manifest.coverage && ` ${t.fromPeriod} ${formatRange(manifest.coverage, locale)}`}
              {`. ${t.updated} ${formatDate(manifest.generatedAt.slice(0, 10), locale)}.`}
            </p>
          )}
        </Overlay>
      )}

      {draft && !draft.closed && (
        <div className="draw-bar" role="region" aria-label={t.drawArea}>
          <p>
            <strong>{t.drawArea}</strong>
            <span>{t.drawHint}</span>
          </p>
          <div className="draw-actions">
            <button type="button" className="ghost" onClick={useCurrentView}>{t.drawUseView}</button>
            <button
              type="button"
              className="ghost"
              disabled={!draft.points.length}
              onClick={() => setDraft({ ...draft, points: draft.points.slice(0, -1) })}
            >
              {t.drawUndo}
            </button>
            <button type="button" className="ghost" onClick={() => setDraft(null)}>{t.cancel}</button>
            <button
              type="button"
              className="primary"
              disabled={draft.points.length < MIN_AREA_POINTS}
              onClick={() => setDraft({ ...draft, closed: true })}
            >
              {t.drawFinish}
            </button>
          </div>
        </div>
      )}

      {draft?.closed && (
        <Overlay
          id="new-watch"
          title={draft.editing ? t.editWatch : t.addWatch}
          onClose={() => setDraft(null)}
          t={t}
          className="centre"
        >
          <p className="muted">{`${t.watchArea}: ${describeArea(draft.points, t)}`}</p>
          <label className="field" htmlFor="watch-name">
            <span>{t.nameWatch}</span>
            <input
              id="watch-name"
              type="text"
              value={draft.name}
              placeholder={t.namePlaceholder}
              maxLength={40}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </label>
          <fieldset>
            <legend>{t.typesWatched}</legend>
            <p className="field-hint">{t.typesHint}</p>
            <CategoryPicker
              idPrefix="watch"
              selected={(category) => draft.categories.includes(category)}
              toggle={(category) => setDraft({
                ...draft,
                categories: draft.categories.includes(category)
                  ? draft.categories.filter((item) => item !== category)
                  : [...draft.categories, category],
              })}
              t={t}
            />
          </fieldset>
          <button type="button" className="primary" onClick={saveDraft}>
            {draft.editing ? t.saveChanges : t.saveWatch}
          </button>
        </Overlay>
      )}

      <button
        type="button"
        className="info-trigger"
        aria-label={t.info}
        aria-expanded={panel === 'info'}
        onClick={() => setPanel(panel === 'info' ? null : 'info')}
      >
        <Info size={20} aria-hidden="true" />
      </button>
    </div>
  );
}

const styles = `
  :root{
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;
    --paper:#fbfaf7;--ink:#19201c;--muted:#5b645e;--line:rgba(25,32,28,.14);
    --blue:#1f4fc4;--alert:#a32b1f;
    color:var(--ink);background:#dfe3df;color-scheme:light;font-synthesis:none;
  }
  *{box-sizing:border-box}
  html,body,#root{margin:0;width:100%;height:100%;overflow:hidden}
  button{font:inherit;color:inherit}
  h1,h2,h3{font-weight:650;letter-spacing:-.015em}
  :focus-visible{outline:2px solid var(--blue);outline-offset:2px;border-radius:6px}
  .visually-hidden{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
  .skip-link{position:absolute;z-index:900;left:12px;top:-60px;padding:10px 14px;border-radius:10px;background:#1d2923;color:#fbfaf7;font-size:14px;text-decoration:none;transition:top .15s}
  .skip-link:focus{top:12px}

  .app-shell{position:relative;width:100%;height:100%;background:#dfe3df}
  .map{position:absolute;inset:0;z-index:0}
  .map.drawing{cursor:crosshair}
  .leaflet-container{font-family:inherit;background:#dfe3df}
  .leaflet-control-attribution{font-size:11px!important;background:rgba(251,250,247,.82)!important;color:#5b645e!important}
  .leaflet-control-zoom{border:0!important;box-shadow:0 8px 30px rgba(18,27,22,.14)!important;margin:0 18px 76px 0!important}
  .leaflet-control-zoom a{border:0!important;color:#19201c!important;background:#faf9f5!important}

  .topbar{position:absolute;z-index:600;left:50%;top:18px;width:max-content;max-width:calc(100% - 36px);display:flex;flex-direction:column;overflow:hidden;background:rgba(251,250,247,.95);border:1px solid rgba(255,255,255,.8);border-radius:16px;box-shadow:0 8px 32px rgba(28,38,32,.12);backdrop-filter:blur(20px);transform:translateX(-50%)}
  .topbar-row{display:flex;align-items:center;gap:12px;padding:9px 10px}
  .topbar-row + .topbar-row{border-top:1px solid var(--line)}
  .legend-row{justify-content:space-between;gap:18px}

  .period-wrap{position:relative;flex:0 0 auto;width:250px}
  .period-control{width:100%;height:44px;display:flex;align-items:center;gap:10px;padding:0 12px;border:0;border-radius:12px;background:#f0efe9;color:var(--ink);text-align:left;cursor:pointer}
  .period-control>svg:first-child{flex:0 0 auto;color:var(--blue)}
  .period-control>svg:last-child{margin-left:auto;color:var(--muted);transition:transform .18s}
  .period-control[aria-expanded=true]>svg:last-child{transform:rotate(180deg)}
  .period-control>span{min-width:0;display:flex;flex-direction:column}
  .period-control small{color:var(--muted);font-size:11px;letter-spacing:.06em;text-transform:uppercase}
  .period-control strong{margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:650}
  .period-popover{position:absolute;z-index:720;top:52px;left:0;width:min(360px,calc(100vw - 24px));padding:16px;border:1px solid rgba(255,255,255,.9);border-radius:16px;background:var(--paper);box-shadow:0 18px 54px rgba(22,31,26,.2)}
  .preset-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
  .preset-grid button{height:44px;border:1px solid var(--line);border-radius:11px;background:var(--paper);color:var(--ink);font-size:13px;cursor:pointer}
  .preset-grid button:hover{background:#f0efe9}
  .preset-grid button[aria-pressed=true]{border-color:#1d2923;background:#1d2923;color:var(--paper)}
  .popover-title{margin:16px 0 10px;color:var(--muted);font-size:12px;letter-spacing:.06em;text-transform:uppercase}
  .date-fields{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  .date-fields label,.field{display:flex;flex-direction:column;gap:6px}
  .date-fields span,.field>span{color:var(--muted);font-size:12px}
  .date-fields input,.field input{height:44px;padding:0 11px;border:1px solid var(--line);border-radius:11px;background:#fff;color:var(--ink);font:650 14px inherit}

  .top-actions{display:flex;align-items:center;gap:4px;flex:0 0 auto}
  .icon-button{position:relative;width:44px;height:44px;display:grid;place-items:center;border:0;border-radius:12px;background:transparent;color:var(--ink);cursor:pointer;transition:background .15s}
  .icon-button:hover{background:#f0efe9}
  .icon-button.alert{color:var(--alert)}
  .badge{position:absolute;top:5px;right:4px;min-width:19px;height:19px;padding:0 5px;display:grid;place-items:center;border-radius:10px;background:var(--alert);color:#fff;font-size:11px;font-weight:700}
  .language{height:38px;padding:0 12px;border:1px solid var(--line);border-radius:11px;background:transparent;color:var(--ink);font-size:13px;cursor:pointer;white-space:nowrap}
  .language:hover{background:#f0efe9}


  .panel{position:absolute;z-index:500;left:18px;top:150px;bottom:76px;width:392px;overflow:auto;scrollbar-width:none}
  .panel::-webkit-scrollbar{display:none}
  .card{position:relative;padding:22px;background:var(--paper);border:1px solid rgba(255,255,255,.9);border-radius:18px;box-shadow:0 16px 46px rgba(24,33,28,.16)}
  .card.message{display:flex;flex-direction:column;gap:12px;color:var(--muted);font-size:14px}
  .panel-close{position:absolute;right:12px;top:12px}
  .eyebrow{margin:0;color:var(--muted);font-size:12px;letter-spacing:.08em;text-transform:uppercase}
  .summary h1{margin:0 0 8px;font-size:40px;line-height:1}
  .summary h1 span{font-size:15px;font-weight:500;letter-spacing:0;color:var(--muted)}
  .place-title{margin:10px 0 4px;font-size:25px}
  .muted{display:flex;align-items:center;gap:7px;margin:6px 0 0;color:var(--muted);font-size:13px;line-height:1.55}
  .approximate{display:flex;align-items:center;gap:7px;margin:12px 0 0;padding:10px 11px;border-radius:10px;background:#f4eee2;color:#7a5716;font-size:13px}
  .unlocated{margin-top:16px;border-top:1px solid var(--line);padding-top:12px}
  .unlocated summary{font-size:13px;cursor:pointer}

  .notice-list{margin-top:8px}
  .notice-card{padding:16px 0;border-top:1px solid var(--line)}
  .notice-card h3{margin:0;font-size:15px;line-height:1.4}
  .notice-address{margin:6px 0 0;color:var(--muted);font-size:13px}
  .category-chip{display:inline-flex;align-items:center;gap:7px;margin:10px 0 0;padding:4px 10px;border-radius:8px;background:#f0efe9;font-size:12px}
  .chip-dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto}
  .notice-card dl{display:flex;flex-wrap:wrap;gap:8px;margin:11px 0 0}
  .notice-card dl div{flex:1 1 auto;min-width:110px;padding:9px 11px;border-radius:10px;background:#f0efe9}
  .notice-card dt{margin:0;color:var(--muted);font-size:11px;letter-spacing:.05em;text-transform:uppercase}
  .notice-card dd{margin:4px 0 0;font-size:14px;font-weight:650}
  .notice-card .night{display:flex;align-items:center;gap:7px;margin:10px 0 0;color:#4f4270;font-size:13px}
  .notice-card footer{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-top:12px;color:var(--muted);font-size:12px}
  .notice-card footer a{display:inline-flex;align-items:center;gap:6px;color:var(--blue);font-size:13px;font-weight:650}

  .overlay{position:absolute;z-index:700;padding:20px;background:var(--paper);border:1px solid rgba(255,255,255,.9);border-radius:18px;box-shadow:0 22px 60px rgba(22,31,26,.24);overflow:auto;scrollbar-width:none}
  .overlay::-webkit-scrollbar{display:none}
  .overlay.side{right:18px;top:150px;bottom:76px;width:392px}
  .overlay.centre{left:50%;top:50%;width:min(480px,calc(100% - 36px));max-height:min(76vh,720px);transform:translate(-50%,-50%)}
  .overlay-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}
  .overlay-head h2{margin:0;font-size:19px;outline:0}
  .overlay p{margin:0 0 10px;font-size:14px;line-height:1.6}
  .overlay .lead{font-size:15px;font-weight:650}
  .overlay h3{margin:18px 0 8px;font-size:14px}
  .source-list{margin:0;padding-left:18px;font-size:13px;line-height:1.7;color:var(--muted)}
  .source-list a{color:var(--blue)}

  .category-picker{margin:0;padding:0;list-style:none}
  .category-picker label{display:grid;grid-template-columns:auto auto 1fr auto;align-items:center;gap:11px;padding:11px 9px;border-radius:10px;font-size:14px;cursor:pointer}
  .category-picker label:hover{background:#f0efe9}
  .category-picker input{width:18px;height:18px;accent-color:#1d2923}
  .picker-count{color:var(--muted);font-size:13px}

  .primary{display:inline-flex;align-items:center;justify-content:center;gap:8px;width:100%;height:46px;margin-top:14px;padding:0 16px;border:0;border-radius:12px;background:#1d2923;color:var(--paper);font-size:14px;font-weight:650;cursor:pointer}
  .primary:disabled{background:#c3c7c2;cursor:not-allowed}
  .ghost{display:inline-flex;align-items:center;justify-content:center;gap:7px;height:40px;padding:0 14px;border:1px solid var(--line);border-radius:11px;background:transparent;color:var(--ink);font-size:13px;cursor:pointer}
  .ghost:hover{background:#f0efe9}
  .ghost:disabled{color:#9aa09b;cursor:not-allowed}
  .ghost.small{height:34px;padding:0 11px;font-size:12px}
  .ghost.danger{color:var(--alert);border-color:rgba(163,43,31,.3)}

  .watch-list{margin:14px 0 0;padding:0;list-style:none}
  .watch-list>li{padding:14px 0;border-top:1px solid var(--line)}
  .watch-head h3{margin:0;font-size:16px}
  .watch-count{margin:8px 0 0;font-size:13px;font-weight:650;color:var(--muted)}
  .watch-count.alert{color:var(--alert)}
  .watch-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
  .empty-watches p{margin:0 0 8px}
  fieldset{margin:14px 0 0;padding:0;border:0}
  legend{padding:0;color:var(--muted);font-size:12px}

  .draw-bar{position:absolute;z-index:650;left:50%;bottom:18px;width:min(620px,calc(100% - 36px));display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;border-radius:16px;background:var(--paper);box-shadow:0 16px 46px rgba(24,33,28,.2);transform:translateX(-50%)}
  .draw-bar p{display:flex;flex-direction:column;gap:4px;margin:0;font-size:13px}
  .draw-bar strong{font-size:14px}
  .draw-bar span{color:var(--muted)}
  .draw-actions{display:flex;flex-wrap:wrap;gap:8px}
  .draw-actions .primary{width:auto;height:40px;margin:0}

  .legend{display:flex;gap:6px;flex:0 0 auto;overflow-x:auto;scrollbar-width:none}
  .legend::-webkit-scrollbar{display:none}
  .legend button{display:inline-flex;align-items:center;gap:8px;flex:0 0 auto;height:34px;padding:0 12px;border:1px solid var(--line);border-radius:10px;background:transparent;color:var(--ink);font-size:13px;white-space:nowrap;cursor:pointer;transition:opacity .15s}
  .legend button:hover{background:#f0efe9}
  .legend button[aria-pressed=false]{opacity:.42}
  .legend button[aria-pressed=false] .chip-dot{background:#b7bcb8!important}
  .legend b{color:var(--muted);font-weight:650}
  .legend-note{display:flex;align-items:center;gap:8px;margin:0;color:var(--muted);font-size:12px;white-space:nowrap}
  .chip-dot.hollow{background:var(--paper);box-shadow:inset 0 0 0 2px var(--muted)}
  .card-note{margin:14px 0 0;padding-top:12px;border-top:1px solid var(--line);color:var(--muted);font-size:12px;line-height:1.5}
  .field-hint{margin:4px 0 8px;color:var(--muted);font-size:12px}
  .info-trigger{position:absolute;z-index:560;right:18px;bottom:18px;width:44px;height:44px;display:grid;place-items:center;border:1px solid rgba(255,255,255,.82);border-radius:50%;background:rgba(251,250,247,.95);color:var(--ink);box-shadow:0 7px 24px rgba(25,34,29,.13);backdrop-filter:blur(16px);cursor:pointer}
  .info-trigger:hover{background:#fff;color:var(--blue)}
  .unlocated.card{padding:14px 18px}
  .unlocated summary{font-size:13px;cursor:pointer}

  .melu-marker{display:grid;place-items:center;width:26px;height:26px;border:2.5px solid var(--paper);border-radius:50%;background:var(--dot);color:#fff;font-size:12px;font-weight:700;box-shadow:0 4px 12px rgba(18,26,22,.3)}
  /* Approximate points read as hollow, so a district centroid is never mistaken
     for a surveyed address. */
  .melu-marker.imprecise{border-color:var(--dot);background:var(--paper);color:var(--dot);box-shadow:0 3px 9px rgba(18,26,22,.2)}

  @media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}

  @media(max-width:980px){
    .topbar{top:12px;max-width:calc(100% - 24px);gap:8px}
    .brand-text{display:none}
    .panel,.overlay.side{left:12px;right:12px;top:auto;bottom:76px;width:auto;max-height:52vh}
    /* On one column the results and a side panel would stack on top of each other. */
    .panel.behind{display:none}
    .info-trigger{right:12px;bottom:12px}
    .draw-bar{left:12px;right:12px;bottom:70px;width:auto;transform:none}
    .leaflet-control-zoom{margin:0 12px 76px 0!important}
  }

  .lang-short{display:none}

  /* Only at phone width is the bar wide enough to be worth filling; above that a
     stretched bar is mostly empty space beside three controls. */
  @media(max-width:560px){
    .topbar{left:12px;right:12px;width:auto;max-width:none;transform:none}
    .legend-row{flex-direction:column;align-items:stretch;gap:7px}
    .legend{flex-wrap:wrap;overflow:visible}
    .legend button{flex:1 1 auto;justify-content:space-between}
    .legend-note{font-size:11px;white-space:normal}
    .period-wrap{flex:1 1 auto;width:auto;min-width:0}
    .period-control small{display:none}
    .language{padding:0 10px}
    .lang-long{display:none}
    .lang-short{display:inline}
    .icon-button{width:40px;height:40px}
    .summary h1{font-size:34px}
    /* The period, the watches and the information must stay reachable at this
       width; centring on your own location is the one convenience that can go. */
    .icon-button.locate{display:none}
    .period-control strong{font-size:13px}
  }

  /* At phone width the date must stay readable, so the decorative mark gives way. */
  @media(max-width:430px){
    .brand{display:none}
  }
`;

if (typeof document !== 'undefined' && document.getElementById('root')) {
  const sheet = document.createElement('style');
  sheet.textContent = styles;
  document.head.appendChild(sheet);
  createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);
}

export default App;
