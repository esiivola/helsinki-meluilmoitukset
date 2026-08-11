// Collects Helsinki noise-notice (meluilmoitus) decisions from the city's public
// decision index, structures them, geocodes them against the committed gazetteer,
// and publishes the chunked JSON the map reads.
//
//   node scripts/update-noise-data.mjs             daily incremental run
//   node scripts/update-noise-data.mjs --backfill  re-read the whole archive

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { fetchJson } from './lib/fetch-json.mjs';
import { extractDecision, isPublishable } from './lib/extract.mjs';
import { buildIndex, locateAll } from './lib/geocode.mjs';
import { buildChunks, buildManifest, serialiseChunk } from './lib/publish.mjs';

const ELASTIC = 'https://paatokset-elastic-proxy.api.hel.ninja/paatokset_decisions/_search';
const CATEGORY = 'Meluilmoitus';
const PAGE_SIZE = 250;
const INCREMENTAL_PAGES = 2;

// Bump this whenever existing source documents need to be re-extracted. A script
// push then performs one full backfill automatically instead of leaving old
// records on the previous parser until someone remembers workflow_dispatch.
export const EXTRACTION_VERSION = 2;

const ARCHIVE = new URL('../data/decisions.json', import.meta.url);
const GAZETTEER = new URL('../data/gazetteer.json', import.meta.url);
const PUBLIC_DIR = new URL('../public/data/', import.meta.url);

const SOURCE_FIELDS = [
  'id', 'issue_id', 'unique_issue_id', 'subject', 'issue_subject', 'meeting_date',
  'decision_url', 'decision_content', 'organization_above_name', 'organization_name',
];

function query(from, size) {
  return {
    query: {
      bool: {
        filter: [
          { term: { search_api_language: 'fi' } },
          { term: { field_is_decision: true } },
          { match_phrase: { category_name: CATEGORY } },
        ],
      },
    },
    sort: [{ meeting_date: 'desc' }, { search_api_id: 'asc' }],
    _source: SOURCE_FIELDS,
    track_total_hits: true,
    from,
    size,
  };
}

async function fetchPage(from, size) {
  return fetchJson(ELASTIC, 60000, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(query(from, size)),
  });
}

async function fetchDecisions({ backfill }) {
  const first = await fetchPage(0, PAGE_SIZE);
  const total = first.hits?.total?.value ?? 0;
  if (!Array.isArray(first.hits?.hits) || first.hits.hits.length === 0) {
    throw new Error('Decision index returned no results, refusing to publish');
  }
  const documents = first.hits.hits.map((hit) => hit._source);
  const pages = backfill ? Math.ceil(total / PAGE_SIZE) : INCREMENTAL_PAGES;
  for (let page = 1; page < pages; page += 1) {
    const next = await fetchPage(page * PAGE_SIZE, PAGE_SIZE);
    const hits = next.hits?.hits ?? [];
    if (!hits.length) break;
    documents.push(...hits.map((hit) => hit._source));
  }
  return { documents, total };
}

async function readArchive() {
  try {
    const parsed = JSON.parse(await readFile(ARCHIVE, 'utf8'));
    return {
      extractionVersion: parsed.extractionVersion || null,
      notices: Array.isArray(parsed.notices) ? parsed.notices : [],
    };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { extractionVersion: null, notices: [] };
  }
}

export function shouldBackfill(archive, requested) {
  return Boolean(requested) || archive?.extractionVersion !== EXTRACTION_VERSION;
}

// A backfill is a clean reconstruction, not an incremental merge. Starting from
// the old archive would preserve a stale record if it disappeared from the source
// index or the current parser deliberately stopped publishing it.
export function archiveSeed(archive, backfill) {
  return backfill ? [] : (archive?.notices || []);
}

function toNotice(source, index) {
  const decision = extractDecision(source);
  if (!decision.id || !isPublishable(decision.title)) return null;
  const primary = locateAll(index, decision.locationText);
  const locations = primary.length ? primary : locateAll(index, decision.fallbackLocationText);
  const { text, clause, locationText, fallbackLocationText, ...rest } = decision;
  return { ...rest, locations };
}

const byDateDescending = (a, b) => (b.decisionDate || '').localeCompare(a.decisionDate || '')
  || (a.id || '').localeCompare(b.id || '');

async function main() {
  const archive = await readArchive();
  const backfill = shouldBackfill(archive, process.argv.includes('--backfill'));
  const gazetteer = JSON.parse(await readFile(GAZETTEER, 'utf8'));
  const index = buildIndex(gazetteer);

  const { documents, total } = await fetchDecisions({ backfill });
  const merged = new Map(archiveSeed(archive, backfill).map((notice) => [notice.id, notice]));
  let added = 0;
  for (const source of documents) {
    const notice = toNotice(source, index);
    if (!notice) continue;
    if (!merged.has(notice.id)) added += 1;
    merged.set(notice.id, notice);
  }

  const notices = [...merged.values()].sort(byDateDescending);
  if (notices.length < merged.size) throw new Error('Archive merge lost records');

  const generatedAt = new Date().toISOString();
  const today = generatedAt.slice(0, 10);
  const located = notices.filter((notice) => notice.locations.length).length;
  const dated = notices.filter((notice) => notice.start).length;

  // Only index.json carries a timestamp. Everything else stays byte-identical
  // between runs unless its content actually changed, so the daily commit is a
  // couple of kilobytes rather than a full rewrite of the archive.
  await mkdir(new URL('.', ARCHIVE), { recursive: true });
  await writeFile(ARCHIVE, `${JSON.stringify({
    schemaVersion: 1,
    extractionVersion: EXTRACTION_VERSION,
    sourceTotal: total,
    notices,
  })}\n`, 'utf8');

  const chunks = buildChunks(notices, today);
  await mkdir(PUBLIC_DIR, { recursive: true });
  for (const chunk of chunks) {
    await writeFile(new URL(chunk.file, PUBLIC_DIR), serialiseChunk(chunk), 'utf8');
  }
  await writeFile(
    new URL('index.json', PUBLIC_DIR),
    `${JSON.stringify(buildManifest(chunks, generatedAt, notices.length, notices), null, 2)}\n`,
    'utf8',
  );

  console.log([
    `source total ${total}`,
    backfill ? `extraction v${EXTRACTION_VERSION} backfill` : `extraction v${EXTRACTION_VERSION} incremental`,
    `fetched ${documents.length}`,
    `new ${added}`,
    `archive ${notices.length}`,
    `located ${located} (${Math.round((located / notices.length) * 100)}%)`,
    `dated ${dated} (${Math.round((dated / notices.length) * 100)}%)`,
    `chunks ${chunks.length}`,
  ].join(' · '));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
