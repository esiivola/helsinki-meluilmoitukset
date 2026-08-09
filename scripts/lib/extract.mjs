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
  const match = text.match(/joka koskee ([\s\S]{0,500}?)(?:,?\s*ilmoituksessa esitetyll|\s*sek[aä] seuraavin m[aä][aä]r[aä]yksin|\.\s)/i);
  return match ? match[1].trim() : null;
}

// Section bodies are useful fallbacks when the operative clause omits a date.
export function section(text, heading) {
  const start = text.indexOf(heading);
  if (start < 0) return null;
  return text.slice(start + heading.length, start + heading.length + 1200).trim();
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

const RANGE_RE = new RegExp(
  `(\\d{1,2})\\.${SPACE}*(\\d{1,2})\\.${SPACE}*(\\d{4})?${SPACE}*${DASH}${SPACE}*(\\d{1,2})\\.${SPACE}*(\\d{1,2})\\.${SPACE}*(\\d{4})`,
);
const SINGLE_RE = /(\d{1,2})\.[\s ]*(\d{1,2})\.[\s ]*(\d{4})/;

// "10.8.2026 - 31.5.2028", "6.5. - 31.5.2019", "10.8.−30.9.2026", or a single date.
export function parsePeriod(text) {
  if (!text) return null;
  const range = text.match(RANGE_RE);
  if (range) {
    const [, d1, m1, y1, d2, m2, y2] = range;
    const start = toIso(d1, m1, y1 || y2);
    const end = toIso(d2, m2, y2);
    if (start && end && start <= end) return { start, end };
    if (start && end) return { start: end, end: start };
  }
  const single = text.match(SINGLE_RE);
  if (single) {
    const iso = toIso(single[1], single[2], single[3]);
    if (iso) return { start: iso, end: iso };
  }
  return null;
}

// Tries the operative clause first, then the notice-content section, then the head of
// the document. Anything found outside the clause is reported as lower confidence.
export function resolvePeriod(text, clause) {
  const fromClause = parsePeriod(clause);
  if (fromClause) return { ...fromClause, confidence: 'high' };
  for (const heading of ['Ilmoituksen sisältö', 'Ilmoitus koskee', 'Päätös']) {
    const found = parsePeriod(section(text, heading));
    if (found) return { ...found, confidence: 'medium' };
  }
  const head = parsePeriod(text.slice(0, 2000));
  return head ? { ...head, confidence: 'low' } : null;
}

const HOURS_RE = new RegExp(
  `kello${SPACE}+(\\d{1,2})[.:](\\d{2})${SPACE}*${DASH}${SPACE}*(\\d{1,2})[.:](\\d{2})`,
  'g',
);
const PROHIBITED = /kielletty|kiellettyj[aä]|ei saa|v[aä]ltett[aä]v[aä]|vain pakottavista/i;
const ALLOWED = /sallittu|sallittuja|saa tehd[aä]|saa k[aä]ytt[aä][aä]|saa suorittaa|tehd[aä][aä]n/i;

function clock(hour, minute) {
  return `${String(Number(hour)).padStart(2, '0')}:${minute}`;
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
    const key = `${kind}:${from}:${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    windows.push({ kind, from, to });
  }
  return windows;
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
  if (/^(Lausunto|Oikaisuvaatimus|Vastine|Selvitys)\b/i.test(subject)) return false;
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
  const period = resolvePeriod(text, clause);
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
    decisionDate,
    start: period?.start || null,
    end: period?.end || null,
    periodConfidence: period?.confidence || null,
    hours: parseHourWindows(text),
    nightWork: hasNightWork([subject, clause].filter(Boolean).join(' ')),
    authority: org || null,
    clause,
    text,
  };
}
