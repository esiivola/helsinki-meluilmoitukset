import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  classify, decisionClause, extractDecision, hasNightWork, htmlToText,
  isPublishable, parseHourWindows, parsePeriod, parseSubject,
} from '../scripts/lib/extract.mjs';
import { areaForms, buildIndex, locateAll, normalize, resolvePartialName, titleCase } from '../scripts/lib/geocode.mjs';
import { buildChunks, buildManifest, contentHash, coverage, isCurrent, noticeSpan, serialiseChunk, shiftDays, yearsCovered } from '../scripts/lib/publish.mjs';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const fixtures = read('./fixtures/decisions.json');
const index = buildIndex(read('../data/gazetteer.json'));

const bySubject = (needle) => fixtures.find((doc) => doc.subject[0].includes(needle));

describe('text extraction', () => {
  it('strips markup and entities without gluing words together', () => {
    expect(htmlToText('<p>Ty&ouml;t&auml;</p><li>7.00</li>')).toBe('Työtä 7.00');
  });

  it('parses the three date-range notations used in decisions', () => {
    expect(parsePeriod('10.8.2026 - 31.5.2028')).toEqual({ start: '2026-08-10', end: '2028-05-31' });
    expect(parsePeriod('purkutyön jatkumista 10.8.−30.9.2026')).toEqual({ start: '2026-08-10', end: '2026-09-30' });
    expect(parsePeriod('kunnossapitotöitä 6.5. - 31.5.2019')).toEqual({ start: '2019-05-06', end: '2019-05-31' });
    expect(parsePeriod('ulkoilmaelokuvaesitystä 25.8.2026')).toEqual({ start: '2026-08-25', end: '2026-08-25' });
  });

  it('rejects impossible dates rather than rolling them over', () => {
    expect(parsePeriod('31.2.2026')).toBeNull();
    expect(parsePeriod('ei päivämäärää')).toBeNull();
  });

  it('tags hour windows as permitted or forbidden', () => {
    const windows = parseHourWindows(
      'Häiritsevää melua aiheuttavien koneiden käyttö on kielletty yöaikaan kello 22.00−7.00. '
      + 'Hydraulisen iskuvasaran käyttö on sallittua vain arkisin kello 7.00−15.00.',
    );
    expect(windows).toContainEqual({ kind: 'prohibited', from: '22:00', to: '07:00' });
    expect(windows).toContainEqual({ kind: 'allowed', from: '07:00', to: '15:00' });
  });

  it('deduplicates repeated hour windows', () => {
    expect(parseHourWindows('sallittua kello 7.00-18.00 ja sallittua kello 7.00-18.00')).toHaveLength(1);
  });

  it('reads both subject conventions and amendments', () => {
    expect(parseSubject('Päätös Terramare Oy:n meluilmoituksesta koskien LJ6-laituriurakan rakennustöitä'))
      .toEqual({ applicant: 'Terramare Oy', activity: 'LJ6-laituriurakan rakennustöitä', format: 'decision' });
    expect(parseSubject('Päätös Umacon Oy:n meluilmoituksesta, joka koskee iskuvasaran käyttöä osoitteessa Gunillantie 3'))
      .toMatchObject({ applicant: 'Umacon Oy', activity: 'iskuvasaran käyttöä osoitteessa Gunillantie 3' });
    expect(parseSubject('Päätös SRV Infra Oy:n meluilmoituksen muutoksesta koskien paalutusta'))
      .toMatchObject({ applicant: 'SRV Infra Oy', activity: 'paalutusta' });
    expect(parseSubject('Meluilmoitus, louhintatyö, Maunulantie 21, SRV Rakennus Oy'))
      .toEqual({ applicant: 'SRV Rakennus Oy', activity: 'louhintatyö', format: 'notice' });
  });

  it('classifies from the subject, not the boilerplate conditions', () => {
    // Every construction decision repeats "eika niihin rinnastettavina juhlapaivina".
    expect(classify('kiskotyötä Hämeentien risteyksessä', 'ei saa tehdä pyhäpäivinä')).toBe('construction');
    expect(classify('louhintaa osoitteessa Kirkonkyläntie 17', '')).toBe('construction');
    expect(classify('yrityksen kesäjuhlan ulkoilmakonserttia', '')).toBe('event');
    expect(classify('aiemman ilmoituksen jatkumista', '')).toBe('other');
  });

  it('ignores the address, which carries place names that read as activities', () => {
    // Katajanokanlaituri is a street, not a pier under construction.
    expect(classify('ulkoilmakonserttia osoitteessa Katajanokanlaituri 2a', '')).toBe('event');
    // Messuaukio is a square, not a trade fair.
    expect(classify('piikkausta ja suurtehoimurointia osoitteessa Messuaukio 1', '')).toBe('construction');
  });

  it('matches the Finnish spelling of a loan word', () => {
    // "festivaali" does not contain the English "festival".
    expect(classify('Teurastamo Festivaalia', '')).toBe('event');
    expect(classify('Electronic Fields Festivalia', '')).toBe('event');
  });

  it('prefers the event reading when both patterns could match', () => {
    expect(classify('Under the Bridge ulkoilmatapahtumaa Hämeentien sillan alla', '')).toBe('event');
  });

  it('falls back to the whole subject when there is no activity part', () => {
    expect(classify('', 'Kalliolan Nuoret Ry meluilmoitus, ulkoilmatapahtuma Alppipuistossa')).toBe('event');
  });

  it('detects night work and the operative clause', () => {
    expect(hasNightWork('yötyönä tehtävää purkua')).toBe(true);
    expect(hasNightWork('työ tehdään päiväaikaan')).toBe(false);
    // The standard condition banning night work must not read as night work.
    expect(hasNightWork('ellei yötyö ole liikenneturvallisuuden vuoksi välttämätöntä')).toBe(false);
    expect(decisionClause('hyväksyä ilmoituksen, joka koskee louhintaa 1.9.2026 osoitteessa Testikatu 1, ilmoituksessa esitetyllä tavalla'))
      .toBe('louhintaa 1.9.2026 osoitteessa Testikatu 1');
  });

  it('excludes withheld decisions and appeal statements', () => {
    expect(isPublishable('Salassa pidettävä (JulkL (621/1999) 24.1 § 7 k)')).toBe(false);
    expect(isPublishable('Lausunto Eteläiset Kaupunginosat Ry:n valituksesta')).toBe(false);
    // A statement to another authority is filed under the same category.
    expect(isPublishable('Helsingin kaupungin ympäristölautakunnan lausunto Hämeen ELY-keskukselle')).toBe(false);
    expect(isPublishable('Päätös Kreate Oy:n meluilmoituksesta koskien paalutusta')).toBe(true);
  });
});

describe('geocoding', () => {
  it('generates the local cases an area name appears in', () => {
    expect(areaForms('Munkkiniemi')).toContain('munkkiniemessä');
    expect(areaForms('Länsisatama')).toContain('länsisatamassa');
  });

  it('weakens a doubled stop the way Finnish does', () => {
    // Kamppi is in Kampissa, not Kamppissa.
    expect(areaForms('Kamppi')).toContain('kampissa');
    expect(areaForms('Katajanokka')).toContain('katajanokan');
  });

  it('reads a name both as its suffix feature and as a plain area', () => {
    // Punavuori takes -vuorella as a hill and -vuoressa as a district.
    const [spot] = locateAll(index, 'louhintaa Punavuoressa');
    expect(spot.label).toBe('Punavuori');
  });

  it('gives every named district its own marker', () => {
    const spots = locateAll(index, 'louhintaa ja pontitusta Punavuoressa, Kampissa ja Töölössä');
    expect(spots.map((spot) => spot.label)).toEqual(expect.arrayContaining(['Punavuori', 'Kamppi']));
  });

  it('reduces a compound to the registered name it is built on', () => {
    // Stansvikinkallio is not registered; Stansvik is.
    const spot = resolvePartialName(index, 'stansvikinkalliolla');
    expect(spot).toMatchObject({ precision: 'area', label: 'Stansvik' });
    expect(spot.lat).toBeCloseTo(60.166, 2);
  });

  it('resolves a shared tail when the names agree on where they are', () => {
    // Esplanadi is the tail of Pohjois-, Etela-, Kappeli- and Teatteriesplanadi,
    // which all sit within a couple of hundred metres of each other.
    const spot = resolvePartialName(index, 'esplanadin');
    expect(spot).toMatchObject({ precision: 'area' });
    expect(spot.lat).toBeCloseTo(60.167, 2);
    expect(spot.lon).toBeCloseTo(24.948, 2);
  });

  it('refuses a tail that is scattered across the city', () => {
    // Hundreds of parks share the tail and they are nowhere near each other.
    expect(resolvePartialName(index, 'puistossa')).toBeNull();
  });

  it('resolves a street address to a point', () => {
    const [spot] = locateAll(index, 'louhintaa osoitteessa Lönnrotinkatu 37, Kamppi');
    expect(spot.precision).toBe('address');
    expect(spot.label).toBe('Lönnrotinkatu 37');
    expect(spot.lat).toBeCloseTo(60.164, 2);
    expect(spot.lon).toBeCloseTo(24.929, 2);
    expect(spot.district).toBe('Kamppi');
  });

  it('resolves multi-token street names', () => {
    const [spot] = locateAll(index, 'paalutusta osoitteessa John Stenbergin ranta 4');
    expect(spot.precision).toBe('address');
    expect(spot.lat).toBeGreaterThan(60.17);
  });

  it('returns one location per site when several are named', () => {
    const spots = locateAll(index, 'ulkoilmaelokuvaesityksiä Karhupuistossa ja Kansalaistorilla');
    expect(spots.length).toBeGreaterThan(1);
    expect(spots.map((spot) => spot.label)).toEqual(expect.arrayContaining(['Karhupuisto', 'Kansalaistori']));
  });

  it('treats two streets as a junction only with a cue and real proximity', () => {
    const [junction] = locateAll(index, 'kiskotyötä Hämeentien ja Mäkelänkadun risteyksessä');
    expect(junction.precision).toBe('intersection');
    expect(junction.lat).toBeCloseTo(60.19, 2);

    // Distant, unrelated venues must not be fused into a fictional crossing.
    const scattered = locateAll(index, 'elokuvaesityksiä Kivinokan uimarannalla ja Lasipalatsinaukiolla');
    expect(scattered.every((spot) => spot.precision !== 'intersection')).toBe(true);
  });

  it('falls back to the district centroid and flags the imprecision', () => {
    const [spot] = locateAll(index, 'louhintaa, iskuvasarointia ja pontitusta Pakilassa');
    expect(spot.precision).toBe('district');
    expect(spot.label).toBe('Pakila');
  });

  it('returns nothing rather than guessing when no place is named', () => {
    expect(locateAll(index, 'ulkoilmakonserttia')).toEqual([]);
    expect(locateAll(index, '')).toEqual([]);
  });

  it('normalises dashes and capitalises compound names', () => {
    expect(normalize('Taka−Töölö ')).toBe('taka-töölö');
    expect(titleCase('taka-töölö')).toBe('Taka-Töölö');
  });
});

describe('end-to-end extraction over real decisions', () => {
  const records = fixtures
    .filter((doc) => isPublishable(doc.subject[0]))
    .map((doc) => {
      const decision = extractDecision(doc);
      return { ...decision, locations: locateAll(index, decision.locationText || decision.title) };
    });

  it('reads a known decision completely', () => {
    const doc = bySubject('Uudenmaan Infrapalvelut');
    const record = extractDecision(doc);
    expect(record).toMatchObject({
      issueId: 'HEL-2026-012622',
      applicant: 'Uudenmaan Infrapalvelut Oy',
      category: 'construction',
      start: '2026-08-10',
      end: '2026-09-30',
      periodConfidence: 'high',
      nightWork: false,
    });
    expect(record.url).toMatch(/^https:\/\/paatokset\.hel\.fi\/fi\/asia\/hel-2026-012622/);
    expect(record.hours).toContainEqual({ kind: 'allowed', from: '07:00', to: '15:00' });

    const [spot] = locateAll(index, record.locationText);
    expect(spot).toMatchObject({ precision: 'address', label: 'Länsisatamankuja 1', district: 'Jätkäsaari' });
  });

  it('dates and locates nearly every decision', () => {
    const dated = records.filter((record) => record.start).length;
    const located = records.filter((record) => record.locations.length).length;
    expect(dated / records.length).toBeGreaterThan(0.95);
    expect(located / records.length).toBeGreaterThan(0.9);
  });

  it('produces coordinates inside the Helsinki region', () => {
    for (const record of records) {
      for (const spot of record.locations) {
        expect(spot.lat).toBeGreaterThan(59.9);
        expect(spot.lat).toBeLessThan(60.35);
        expect(spot.lon).toBeGreaterThan(24.6);
        expect(spot.lon).toBeLessThan(25.35);
      }
    }
  });

  it('never emits a period that ends before it starts', () => {
    for (const record of records) {
      if (record.start && record.end) expect(record.start <= record.end).toBe(true);
    }
  });
});

describe('chunking for lazy loading', () => {
  const notices = [
    { id: 'a', title: 'Long harbour works', start: '2026-08-10', end: '2028-05-31', decisionDate: '2026-07-31', locations: [] },
    { id: 'b', title: 'Concert', start: '2026-08-25', end: '2026-08-25', decisionDate: '2026-07-22', locations: [] },
    { id: 'c', title: 'Old blast', start: '2019-05-06', end: '2019-05-31', decisionDate: '2019-04-25', locations: [] },
    { id: 'd', title: 'Undated', start: null, end: null, decisionDate: '2026-08-01', locations: [] },
  ];

  it('spans dates and falls back to the decision date', () => {
    expect(noticeSpan(notices[0])).toEqual({ start: '2026-08-10', end: '2028-05-31' });
    expect(noticeSpan(notices[3])).toEqual({ start: '2026-08-01', end: '2026-08-01' });
    expect(shiftDays('2026-08-09', -30)).toBe('2026-07-10');
  });

  it('places a multi-year notice in every year it overlaps', () => {
    expect(yearsCovered(notices[0])).toEqual([2026, 2027, 2028]);
    expect(yearsCovered(notices[1])).toEqual([2026]);
  });

  it('caps runaway spans caused by source typos', () => {
    expect(yearsCovered({ start: '2026-01-01', end: '2126-01-01' })).toHaveLength(11);
  });

  it('keeps recently ended and future notices in the current chunk', () => {
    expect(isCurrent(notices[1], '2026-08-09')).toBe(true);
    expect(isCurrent(notices[2], '2026-08-09')).toBe(false);
  });

  it('builds a manifest matching the chunks it describes', () => {
    const chunks = buildChunks(notices, '2026-08-09');
    const manifest = buildManifest(chunks, '2026-08-09T03:00:00Z', notices.length);

    expect(chunks[0].key).toBe('current');
    expect(chunks[0].records.map((record) => record.id).sort()).toEqual(['a', 'b', 'd']);

    const year2027 = chunks.find((chunk) => chunk.key === '2027');
    expect(year2027.records.map((record) => record.id)).toEqual(['a']);

    expect(manifest.chunks).toHaveLength(chunks.length);
    expect(manifest.totalNotices).toBe(4);
    for (const entry of manifest.chunks) {
      expect(entry.count).toBe(chunks.find((chunk) => chunk.key === entry.key).records.length);
    }
  });

  it('serialises a chunk without a timestamp so unchanged years produce no diff', () => {
    const [first] = buildChunks(notices, '2026-08-09');
    const [second] = buildChunks(notices, '2026-08-10');
    expect(serialiseChunk(first)).not.toContain('generatedAt');
    expect(serialiseChunk(first)).toBe(serialiseChunk(second));
    expect(contentHash(serialiseChunk(first))).toBe(contentHash(serialiseChunk(second)));
  });

  it('changes a chunk hash when its content changes', () => {
    const [before] = buildChunks(notices, '2026-08-09');
    const [after] = buildChunks([...notices, { id: 'e', title: 'New', start: '2026-08-12', end: '2026-08-12', decisionDate: '2026-08-11', locations: [] }], '2026-08-09');
    expect(contentHash(serialiseChunk(before))).not.toBe(contentHash(serialiseChunk(after)));
  });

  it('reports the span the archive covers', () => {
    expect(coverage(notices)).toEqual({ from: '2019-05-06', to: '2028-05-31' });
    expect(coverage([])).toBeNull();
  });

  it('strips the full decision text from published records', () => {
    const [chunk] = buildChunks([{ ...notices[0], text: 'long body', clause: 'clause' }], '2026-08-09');
    expect(chunk.records[0]).not.toHaveProperty('text');
    expect(chunk.records[0]).not.toHaveProperty('clause');
  });
});
