// Splits the decision archive into the chunks the browser loads lazily.
// A notice is written into every year its validity period overlaps, so each
// chunk stands alone and the client never has to stitch across files.

export const SCHEMA_VERSION = 1;
export const CURRENT_LOOKBACK_DAYS = 30;

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

export function shiftDays(isoString, days) {
  const date = new Date(`${isoString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return isoDate(date);
}

// A notice occupies its validity period; undated ones fall back to the decision date.
export function noticeSpan(notice) {
  const start = notice.start || notice.decisionDate;
  const end = notice.end || notice.start || notice.decisionDate;
  if (!start || !end) return null;
  return start <= end ? { start, end } : { start: end, end: start };
}

export function yearsCovered(notice) {
  const span = noticeSpan(notice);
  if (!span) return [];
  const first = Number(span.start.slice(0, 4));
  const last = Number(span.end.slice(0, 4));
  if (!Number.isFinite(first) || !Number.isFinite(last)) return [];
  // Guard against a typo in the source producing a century-long span.
  const capped = Math.min(last, first + 10);
  const years = [];
  for (let year = first; year <= capped; year += 1) years.push(year);
  return years;
}

export function isCurrent(notice, today) {
  const span = noticeSpan(notice);
  if (!span) return false;
  return span.end >= shiftDays(today, -CURRENT_LOOKBACK_DAYS);
}

// Fields the map needs. The full text stays in the archive, out of the browser payload.
export function publicRecord(notice) {
  return {
    id: notice.id,
    issueId: notice.issueId,
    url: notice.url,
    title: notice.title,
    applicant: notice.applicant,
    activity: notice.activity,
    category: notice.category,
    decisionDate: notice.decisionDate,
    start: notice.start,
    end: notice.end,
    periods: notice.periods,
    schedule: notice.schedule,
    hours: notice.hours,
    nightWork: notice.nightWork,
    locations: notice.locations,
  };
}

export function buildChunks(notices, today) {
  const byYear = new Map();
  const current = [];
  for (const notice of notices) {
    const record = publicRecord(notice);
    if (isCurrent(notice, today)) current.push(record);
    for (const year of yearsCovered(notice)) {
      if (!byYear.has(year)) byYear.set(year, []);
      byYear.get(year).push(record);
    }
  }

  const bySpanThenTitle = (a, b) => (a.start || '').localeCompare(b.start || '')
    || (a.title || '').localeCompare(b.title || '');

  const chunks = [{
    key: 'current',
    file: 'notices-current.json',
    from: shiftDays(today, -CURRENT_LOOKBACK_DAYS),
    to: null,
    records: current.sort(bySpanThenTitle),
  }];

  for (const year of [...byYear.keys()].sort((a, b) => b - a)) {
    chunks.push({
      key: String(year),
      file: `notices-${year}.json`,
      from: `${year}-01-01`,
      to: `${year}-12-31`,
      records: byYear.get(year).sort(bySpanThenTitle),
    });
  }
  return chunks;
}

// FNV-1a over the serialised chunk. Only used to key the browser's cache, so a
// short non-cryptographic digest is enough, and it lets chunk files stay
// byte-identical between runs when nothing changed.
export function contentHash(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

export function serialiseChunk(chunk) {
  // Deliberately timestamp-free: a chunk that did not change produces the same
  // bytes, so the daily commit stays empty for untouched years.
  return `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, key: chunk.key, notices: chunk.records })}\n`;
}

// The span the archive actually covers, so the service can say what "1485 notices"
// refers to rather than leaving a bare number on screen.
export function coverage(notices) {
  const spans = notices.map(noticeSpan).filter(Boolean);
  if (!spans.length) return null;
  return {
    from: spans.reduce((min, span) => (span.start < min ? span.start : min), spans[0].start),
    to: spans.reduce((max, span) => (span.end > max ? span.end : max), spans[0].end),
  };
}

export function buildManifest(chunks, generatedAt, totalNotices, notices = []) {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt,
    totalNotices,
    coverage: coverage(notices),
    currentLookbackDays: CURRENT_LOOKBACK_DAYS,
    chunks: chunks.map((chunk) => ({
      key: chunk.key,
      file: chunk.file,
      from: chunk.from,
      to: chunk.to,
      count: chunk.records.length,
      hash: contentHash(serialiseChunk(chunk)),
    })),
  };
}
