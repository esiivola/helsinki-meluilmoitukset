// Pure text extraction for Helsinki noise-notice (meluilmoitus) decisions.
// Input is a document from the Ahjo decision index; output is a structured record
// without a location, which geocode.mjs resolves separately.

// Decisions punctuate ranges with any of the Unicode dashes, including U+2014,
// which is written as an escape so that no literal em dash appears in this file.
const DASH = '[-\\u2010\\u2011\\u2012\\u2013\\u2014\\u2212]';
const SPACE = '[\\s\\u00a0]';

const NAMED_ENTITIES = {
  nbsp: ' ', amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', shy: '', ndash: '\u2013', mdash: '\u2014',
  auml: 'ä', Auml: 'Ä', ouml: 'ö', Ouml: 'Ö', aring: 'å', Aring: 'Å', eacute: 'é', uuml: 'ü',
};

export function decodeEntities(value) {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code) => {
    if (code[0] === '#') {
      const point = code[1] === 'x' || code[1] === 'X'
        ? Number.parseInt(code.slice(2), 16)
        : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(point) ? String.fromCodePoint(point) : match;
    }
    return Object.hasOwn(NAMED_ENTITIES, code) ? NAMED_ENTITIES[code] : match;
  });
}

export function htmlToText(html) {
  if (!html) return '';
  return decodeEntities(html
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '$& ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[\s ]+/g, ' ')
    .trim();
}

// The operative sentence: "...ilmoituksen, joka koskee <activity> <period> osoitteessa <place>, ..."
export function decisionClause(text) {
  const match = text.match(/joka koskee ([\s\S]{0,500}?)(?:,?\s*ilmoituksessa esitetyll|\s*sek[aä] seuraavin m[aä][aä]r[aä]yksin|\.\s+(?=[A-ZÅÄÖ]))/i);
  return match ? match[1].trim() : null;
}

// Section bodies are useful fallbacks when the operative clause omits a date.
export function section(text, heading) {
  const start = text.indexOf(heading);
  if (start < 0) return null;
  return text.slice(start + heading.length, start + heading.length + 1200).trim();
}

// Keep the binding decision conditions separate from the applicant's description.
// They can disagree after an application has been corrected, and only the former
// state what the authority actually allowed.
function boundedSection(text, heading, endHeadings, maxLength = 6000) {
  const start = text.indexOf(heading);
  if (start < 0) return null;
  const bodyStart = start + heading.length;
  let end = Math.min(text.length, bodyStart + maxLength);
  for (const candidate of endHeadings) {
    const at = text.indexOf(candidate, bodyStart);
    if (at >= 0 && at < end) end = at;
  }
  return text.slice(bodyStart, end).trim();
}

function decisionBody(text) {
  return boundedSection(text, 'Päätös', [
    'Käsittelymaksu', 'Päätöksen perustelut', 'Ilmoituksen tekijä', 'Ilmoituksen sisältö',
  ]);
}

function toIso(day, month, year) {
  const d = Number(day);
  const m = Number(month);
  const y = Number(year);
  if (!y || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCDate() !== d || date.getUTCMonth() !== m - 1) return null;
  return date.toISOString().slice(0, 10);
}

// The left side is often abbreviated: "24.–26.7.2025" (same month),
// "1.7 - 4.7.2026" (missing the month-ending dot), or "6.5. - 31.5.2019".
const RANGE_RE = new RegExp(
  `(\\d{1,2})\\.(?:(\\d{1,2})(?:\\.(\\d{4})?)?)?${SPACE}*${DASH}${SPACE}*`
  + `(\\d{1,2})\\.${SPACE}*(\\d{1,2})(?:\\.${SPACE}*(\\d{4}))?`,
  'g',
);
const SINGLE_RE = /(\d{1,2})\.[\s ]*(\d{1,2})\.[\s ]*(\d{4})/;

function nearbyYear(text, match) {
  if (match[6]) return Number(match[6]);
  const nearby = text.slice(match.index, match.index + match[0].length + 100);
  const years = [...nearby.matchAll(/\b(?:19|20)\d{2}\b/g)];
  return years.length ? Number(years[years.length - 1][0]) : null;
}

function sortPeriods(periods) {
  return periods.sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
}

export function parsePeriods(text) {
  if (!text) return [];
  const ranges = [];
  for (const match of text.matchAll(RANGE_RE)) {
    const [, d1, statedM1, statedY1, d2, m2, statedY2] = match;
    const endYear = Number(statedY2) || nearbyYear(text, match);
    if (!endYear) continue;
    const startMonth = Number(statedM1 || m2);
    const endMonth = Number(m2);
    let startYear = Number(statedY1) || endYear;
    // A year written only at the end of "15.12.–15.1.2026" applies to the
    // January endpoint; the December endpoint belongs to the previous year.
    if (!statedY1 && startMonth > endMonth) startYear -= 1;
    const start = toIso(d1, startMonth, startYear);
    const end = toIso(d2, endMonth, endYear);
    if (!start || !end) continue;
    ranges.push(start <= end ? { start, end } : { start: end, end: start });
  }
  if (ranges.length) return sortPeriods(ranges);

  const single = text.match(SINGLE_RE);
  if (!single) return [];
  const iso = toIso(single[1], single[2], single[3]);
  return iso ? [{ start: iso, end: iso }] : [];
}

function envelope(periods) {
  if (!periods.length) return null;
  return {
    start: periods.reduce((min, period) => (period.start < min ? period.start : min), periods[0].start),
    end: periods.reduce((max, period) => (period.end > max ? period.end : max), periods[0].end),
  };
}

// "10.8.2026 - 31.5.2028", "6.5. - 31.5.2019", "10.8.−30.9.2026", or a single date.
export function parsePeriod(text) {
  return envelope(parsePeriods(text));
}

function nextDay(iso) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function mergeDatesToPeriods(dates) {
  const sorted = [...new Set(dates)].sort();
  const periods = [];
  for (const date of sorted) {
    const last = periods[periods.length - 1];
    if (last && nextDay(last.end) === date) last.end = date;
    else periods.push({ start: date, end: date });
  }
  return periods;
}

function datedDecisionOccurrences(text) {
  if (!text) return [];
  const dates = [];
  const scanner = new RegExp(SINGLE_RE.source, 'g');
  for (const match of text.matchAll(scanner)) {
    // Binding event conditions commonly give one full date per weekday and put
    // the permitted ending time later in the same phrase.
    if (!/\bkello\b/i.test(text.slice(match.index, match.index + match[0].length + 90))) continue;
    const date = toIso(match[1], match[2], match[3]);
    if (date) dates.push(date);
  }
  return dates;
}

// Tries the operative clause first, then the notice-content section, then the head of
// the document. Anything found outside the clause is reported as lower confidence.
export function resolvePeriod(text, clause, schedule = []) {
  const clausePeriods = parsePeriods(clause);
  if (clausePeriods.length) return { ...envelope(clausePeriods), periods: clausePeriods, confidence: 'high' };
  if (schedule.length) {
    const periods = mergeDatesToPeriods(schedule.map((entry) => entry.date));
    return { ...envelope(periods), periods, confidence: 'high' };
  }
  const bindingText = decisionBody(text);
  const occurrences = datedDecisionOccurrences(bindingText);
  if (occurrences.length > 1) {
    const periods = mergeDatesToPeriods(occurrences);
    return { ...envelope(periods), periods, confidence: 'high' };
  }
  for (const [heading, confidence] of [['Päätös', 'medium'], ['Ilmoituksen sisältö', 'medium'], ['Ilmoitus koskee', 'medium']]) {
    const periods = parsePeriods(heading === 'Päätös' ? bindingText : section(text, heading));
    if (periods.length) return { ...envelope(periods), periods, confidence };
  }
  const periods = parsePeriods(text.slice(0, 2000));
  return periods.length ? { ...envelope(periods), periods, confidence: 'low' } : null;
}

const HOURS_RE = new RegExp(
  `kello${SPACE}+(\\d{1,2})[.:](\\d{2})${SPACE}*${DASH}${SPACE}*(\\d{1,2})[.:](\\d{2})`,
  'g',
);
const PROHIBITED = /kielletty|kiellettyj[aä]|ei saa|v[aä]ltett[aä]v[aä]|vain pakottavista/i;
const ALLOWED = /sallittu|sallittuja|saa tehd[aä]|saa k[aä]ytt[aä][aä]|saa suorittaa|tehd[aä][aä]n/i;

function clock(hour, minute) {
  const h = Number(hour);
  const m = Number(minute);
  if (h < 0 || h > 24 || m < 0 || m > 59 || (h === 24 && m !== 0)) return null;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function lastMatchIndex(text, pattern) {
  const scanner = new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`);
  let last = -1;
  for (const match of text.matchAll(scanner)) last = match.index;
  return last;
}

// Daily time windows, tagged by whether the surrounding text permits or forbids work.
// Sentence boundaries are unusable here because clock times are written with dots
// ("kello 7.00"), so a fixed window of preceding text is inspected instead.
export function parseHourWindows(text) {
  if (!text) return [];
  const windows = [];
  const seen = new Set();
  for (const match of text.matchAll(HOURS_RE)) {
    const context = text.slice(Math.max(0, match.index - 220), match.index);
    // A ban and a permission often sit in adjacent sentences, so the keyword
    // closest to the time wins rather than a fixed precedence.
    const ban = lastMatchIndex(context, PROHIBITED);
    const permit = lastMatchIndex(context, ALLOWED);
    const kind = ban < 0 && permit < 0 ? 'unknown' : (permit > ban ? 'allowed' : 'prohibited');
    const from = clock(match[1], match[2]);
    const to = clock(match[3], match[4]);
    if (!from || !to) continue;
    const key = `${kind}:${from}:${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    windows.push({ kind, from, to });
  }
  return windows;
}

const DATED_HOURS_RE = new RegExp(
  `(\\d{1,2})\\.${SPACE}*(\\d{1,2})\\.${SPACE}*(\\d{4})${SPACE}+kello${SPACE}+`
  + `(\\d{1,2})[.:](\\d{2})${SPACE}*${DASH}${SPACE}*(\\d{1,2})[.:](\\d{2})`,
  'gi',
);

export function parseSchedule(text, defaultKind = 'unknown') {
  if (!text) return [];
  const schedule = [];
  const seen = new Set();
  for (const match of text.matchAll(DATED_HOURS_RE)) {
    const date = toIso(match[1], match[2], match[3]);
    const from = clock(match[4], match[5]);
    const to = clock(match[6], match[7]);
    if (!date || !from || !to) continue;
    const context = text.slice(Math.max(0, match.index - 260), match.index);
    const ban = lastMatchIndex(context, PROHIBITED);
    const permit = lastMatchIndex(context, ALLOWED);
    const kind = ban < 0 && permit < 0 ? defaultKind : (permit > ban ? 'allowed' : 'prohibited');
    const key = `${date}:${kind}:${from}:${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    schedule.push({ date, from, to, kind });
  }
  return schedule.sort((a, b) => a.date.localeCompare(b.date) || a.from.localeCompare(b.from));
}

function uniqueWindows(windows) {
  const seen = new Set();
  return windows.filter((window) => {
    const key = `${window.kind}:${window.from}:${window.to}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function resolveHours(text, bindingText, schedule) {
  if (schedule.length) {
    return uniqueWindows(schedule.map(({ kind, from, to }) => ({ kind, from, to })));
  }
  const binding = parseHourWindows(bindingText || '');
  if (binding.some((window) => window.kind !== 'prohibited')) return binding;

  // When the authority accepts an application as submitted and gives no
  // replacement hours, the application's stated hours remain useful. Limit the
  // fallback to that section rather than returning to a whole-document scan.
  const application = parseHourWindows(section(text, 'Ilmoituksen sisältö'))
    .filter((window) => window.kind !== 'prohibited');
  return uniqueWindows([...binding, ...application]);
}

// Judged from the subject and operative clause only. Nearly every decision bans
// night work in boilerplate ("ellei yötyö ole ... välttämätöntä"), so scanning the
// full body would mark every site as night work.
export function hasNightWork(text) {
  if (!text) return false;
  return /y[oö]ty[oö]n[aä]|y[oö]ty[oö]t[aä]|y[oö]aikaan teht[aä]v[aä]|y[oö]aikana teht[aä]v[aä]|y[oö]ajalla|y[oö]aikaista/i.test(text);
}

// Two subject conventions exist in the archive:
//   A (current): "Paatos <Applicant>:n meluilmoituksesta koskien <activity> ..."
//   B (older):   "Meluilmoitus, <activity>, <place>, <Applicant>"
// Within A the wording varies: plain notices and amendments, "koskien" and
// ", joka koskee", and occasionally a missing space before the verb.
const NOTICE_MARKER = /\s*(?:melu)?ilmoituksen muutoksesta|\s*(?:melu)?ilmoituksesta/i;
const ACTIVITY_LEAD = /^[\s,]*(?:koskien|joka koskee|koskee)?\s*/i;

export function parseSubject(subject) {
  if (!subject) return { applicant: null, activity: null, format: null };
  const marker = subject.match(NOTICE_MARKER);
  if (marker && /^P[aä][aä]t[oö]s\b/i.test(subject)) {
    const applicant = subject
      .slice(0, marker.index)
      .replace(/^P[aä][aä]t[oö]s\s*/i, '')
      .replace(/:?n$/i, '')
      .trim();
    const activity = subject.slice(marker.index + marker[0].length).replace(ACTIVITY_LEAD, '').trim();
    return { applicant: applicant || null, activity: activity || null, format: 'decision' };
  }
  const legacy = subject.match(/^Meluilmoitus,\s*([\s\S]+)$/i);
  if (legacy) {
    const parts = legacy[1].split(',').map((part) => part.trim()).filter(Boolean);
    const applicant = parts.length > 1 ? parts[parts.length - 1] : null;
    return { applicant, activity: parts[0] || null, format: 'notice' };
  }
  return { applicant: null, activity: null, format: 'other' };
}

// Two kinds of activity need a notification under section 118, and the guidance
// names them directly: rakentaminen and yleisotilaisuus. The archive bears this
// out. Of 1485 decisions only six carry both, and all six were address words
// leaking into the match, so a finer split would invent distinctions the data
// does not support.
//
// The event pattern is tried first because it is the more specific signal.
export const CATEGORIES = [
  ['event', new RegExp([
    'ulkoilmakonsert', 'konsert', 'tapahtum', 'festivaal', 'festival', 'tilaisuu', 'esiintymi', 'tanssi',
    'elokuvaesity', 'elokuvan[aä]yt[oö]', 'lenton[aä]yt[oö]', 'n[aä]ytelm', '[aä][aä]nentoisto',
    'juhla', 'juhli', 'kilpailu', 'juoksu', 'ottelu', 'messut', 'markkinat', 'ralli',
    'kisal[aä]hety', 'mainoskuvau',
  ].join('|'), 'i')],
  ['construction', new RegExp([
    'louhin', 'louhe', 'r[aä]j[aä]yt', 'murskau', 'murskai', 'iskuvasar', 'piikkau', 'rammeroin',
    'paalutu', 'pontitu', 'ponttau', 'pontti', 'ankkuroin', 'pora',
    'purkuty', 'purkua', 'purkut[oö]i', 'purkam', 'purkurobot', 'purku-',
    'saneeraus', 'perusparannu', 'korjau', 'uusimist', 'asennusty', 'rakennusty', 'rakentami',
    'kiskoty', 'kisko', 'rata-?ty[oö]', 'ratat[oö]i', 'raitiorat', 'raitiotiety', 'raiteen',
    'juna-?asema', 'ratapih', 'metrorata',
    'ruoppau', 'laituriurak', 'laituriele', 'merity', 'ponttoni',
    'maarakennu', 'kaivu', 'asfaltoin', 'p[aä][aä]llysty', 'katuty', 'kunnossapito',
    'suurtehoimuroin', 'suurtehopuhallu', 'puhallu', 'imuauto', 'imuroin', 'imuty',
    'esirakennus', 'uudistusty', 'kadunrakennus',
    'johtoty', 'kaapeli', 'stabiloin', 'sillan', 'sillat', 'siltoj', 'siltaty', 'silta-',
  ].join('|'), 'i')],
];

export const CATEGORY_KEYS = [...CATEGORIES.map(([key]) => key), 'other'];

// Everything from "osoitteessa" onwards names a place, not an activity. Leaving it
// in made a concert at Katajanokanlaituri read as marine construction and demolition
// at Messuaukio read as an event.
const ADDRESS_TAIL = /\bosoit(?:teessa|teissa|teeseen)\b[\s\S]*$/i;

// Classified from the subject's activity alone. The body cannot be used, since its
// boilerplate repeats "juhlapaivina" in every decision, and neither can the operative
// clause, which runs on into the conditions. The clause is only a fallback for the
// older subject convention, which has no activity part.
// One label per notice. Across the whole archive only two decisions match both
// patterns, both of them concerts held under a bridge, so the first match wins and
// events are tested first as the more specific signal.
export function classify(activity, fallback) {
  const source = (activity && activity.trim()) || fallback || '';
  const haystack = source.replace(ADDRESS_TAIL, ' ');
  const match = CATEGORIES.find(([, pattern]) => pattern.test(haystack));
  return match ? match[0] : 'other';
}

export const DECISION_BASE_URL = 'https://paatokset.hel.fi';

// The category also carries records that are not usable noise permits: decisions
// withheld under the Act on the Openness of Government Activities, and statements
// given on appeals against an earlier permit.
export function isPublishable(subject) {
  if (!subject) return false;
  if (/^Salassa pidett[aä]v[aä]/i.test(subject)) return false;
  // A statement given to another authority is filed under the same category but is
  // not a Helsinki noise permit, wherever the word appears in the subject.
  if (/\b(lausunto|lausunnon|oikaisuvaatimus|vastine|selvitys)\b/i.test(subject)) return false;
  return true;
}

function first(value) {
  return Array.isArray(value) ? value[0] : value;
}

// Maps one Elasticsearch _source document to a structured record (no location yet).
export function extractDecision(source) {
  const subject = first(source.subject) || first(source.issue_subject) || '';
  const html = first(source.decision_content) || '';
  const text = htmlToText(html);
  const clause = decisionClause(text);
  const bindingText = decisionBody(text);
  const bindingSchedule = parseSchedule(bindingText, 'allowed');
  const applicationSchedule = bindingSchedule.length
    ? []
    : parseSchedule(section(text, 'Ilmoituksen sisältö'), 'unknown');
  const schedule = bindingSchedule.length ? bindingSchedule : applicationSchedule;
  const period = resolvePeriod(text, clause, bindingSchedule);
  const { applicant, activity } = parseSubject(subject);
  // Non-standard subjects carry no activity part. The subject is a better fallback
  // than the operative clause, which runs on into the standard conditions.
  const category = classify(activity, subject);
  const decisionDate = first(source.meeting_date)
    ? new Date(first(source.meeting_date) * 1000).toISOString().slice(0, 10)
    : null;
  const path = first(source.decision_url) || '';
  const org = [first(source.organization_above_name), first(source.organization_name)]
    .map((part) => (part || '').trim())
    .filter(Boolean)
    .join(' / ');

  return {
    id: (first(source.id) || '').replace(/[{}]/g, '').toLowerCase() || null,
    issueId: first(source.issue_id) || first(source.unique_issue_id) || null,
    url: path ? `${DECISION_BASE_URL}${path}` : null,
    title: subject,
    applicant,
    activity,
    category,
    locationText: [activity, clause].filter(Boolean).join(' \n '),
    // Second chance for the older subject conventions, which put the address in
    // the subject rather than in an activity part. The applicant is removed first:
    // company names carry place names of their own ("Drumso Idrottskamrater"),
    // which would otherwise pin an event to the wrong side of town.
    fallbackLocationText: applicant ? subject.split(applicant).join(' ') : subject,
    decisionDate,
    start: period?.start || null,
    end: period?.end || null,
    periods: period?.periods || [],
    periodConfidence: period?.confidence || null,
    schedule,
    hours: resolveHours(text, bindingText, schedule),
    nightWork: hasNightWork([subject, clause].filter(Boolean).join(' ')),
    authority: org || null,
    clause,
    text,
  };
}
