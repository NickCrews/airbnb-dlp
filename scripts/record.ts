/**
 * Records fixtures from live airbnb.com: `pnpm record [product ...]`.
 *
 * Each product keeps one fixture per reference area, holding the complete
 * exchanges of a small call. Re-recording replaces the file. Products:
 * search, listings, calendars, priceQuotes, reviews (default: all).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { bookableStays, createClient } from '../src/entry-native.ts';
import { recordingTransport } from '../src/testing/index.ts';
import { impitTransport } from '../src/transport/impit.ts';
import { RECORD_OPTIONS, type Fixture, type Product } from '../test/fixture-suite.ts';
import type { Calendar, SearchQuery, Stay } from '../src/types.ts';

const PRODUCTS: Product[] = ['search', 'listings', 'calendars', 'priceQuotes', 'reviews'];
const root = new URL('..', import.meta.url);
const areas = JSON.parse(readFileSync(new URL('contract/reference-areas.json', root), 'utf8')).areas as {
  id: string;
  kind: string;
  bbox: { south: number; west: number; north: number; east: number };
}[];
const idsPath = new URL('fixtures/listing-ids.json', root);
const ids = JSON.parse(readFileSync(idsPath, 'utf8')) as Record<string, string[]>;

const wanted = process.argv.slice(2).length ? (process.argv.slice(2) as Product[]) : PRODUCTS;
for (const p of wanted) if (!PRODUCTS.includes(p)) throw new Error(`unknown product ${p}; expected one of ${PRODUCTS.join(', ')}`);

function save(fixture: Fixture): void {
  const dir = new URL(`fixtures/${fixture.product}/`, root);
  mkdirSync(dir, { recursive: true });
  const file = new URL(`${fixture.area}.json.gz`, dir);
  writeFileSync(file, gzipSync(JSON.stringify(fixture)));
  console.log(`wrote ${file.pathname} (${fixture.recordings.length} exchanges)`);
}

/**
 * A query that takes few requests: a small box at a dense area's centre, or a
 * whole rural area, with a narrow price range.
 */
function smallQuery(area: (typeof areas)[number]): SearchQuery {
  const { bbox } = area;
  if (area.kind === 'rural') return { area: { bbox }, nightlyPrice: { min: 100, max: 150 } };
  const lat = (bbox.south + bbox.north) / 2;
  const lng = (bbox.west + bbox.east) / 2;
  return {
    area: { bbox: { south: lat - 0.01, north: lat + 0.01, west: lng - 0.015, east: lng + 0.015 } },
    nightlyPrice: { min: 75, max: 300 },
  };
}

const calendars = new Map<string, Calendar[]>();

for (const product of wanted) {
  for (const area of [...areas.map((a) => a.id), 'missing']) {
    // Reviews of a missing listing fail with a generic error, so there is no missing-listing fixture for them.
    if (area === 'missing' && (product === 'search' || product === 'reviews')) continue;
    const transport = recordingTransport(impitTransport());
    const client = createClient({ transport, limits: { requestsPerSecond: 1 } });
    const areaIds = ids[area] ?? [];
    let inputs: unknown[];
    let outcome;
    if (product === 'search') {
      inputs = [smallQuery(areas.find((a) => a.id === area)!)];
      // One place query, so the fixtures cover resolving a place to its map area.
      if (area === 'hilo-hi') inputs.push({ area: { place: 'Hilo, HI' }, nightlyPrice: { min: 100, max: 110 } });
      const { items, outcome: o } = await client.search(inputs as SearchQuery[]).all();
      outcome = o;
      ids[area] = [...new Set(items.map((h) => h.listing.id))].slice(0, 2).concat(ids[area] ?? []).slice(0, 2);
    } else if (product === 'listings') {
      inputs = areaIds;
      outcome = (await client.listings(areaIds).all()).outcome;
    } else if (product === 'calendars') {
      inputs = areaIds;
      const { items, outcome: o } = await client.calendars(areaIds, RECORD_OPTIONS.calendars).all();
      outcome = o;
      calendars.set(area, items.flatMap((r) => (r.ok ? [r.value] : [])));
    } else if (product === 'priceQuotes') {
      let cals = calendars.get(area);
      if (!cals) {
        cals = (await createClient({ limits: { requestsPerSecond: 1 } }).calendars(areaIds, RECORD_OPTIONS.calendars).all()).items.flatMap((r) =>
          r.ok ? [r.value] : [],
        );
      }
      const stays: Stay[] = [];
      for (const cal of cals) {
        const first = bookableStays(cal, cal.days[0]?.date ?? '0000-00-00')[Symbol.iterator]().next();
        if (!first.done) stays.push({ ...first.value, guests: { adults: 2 } });
      }
      if (area === 'missing') stays.push({ id: '1', checkIn: '2030-01-10', checkOut: '2030-01-12' });
      inputs = stays;
      outcome = (await client.priceQuotes(stays).all()).outcome;
    } else {
      inputs = areaIds;
      outcome = (await client.reviews(areaIds, RECORD_OPTIONS.reviews).all()).outcome;
    }
    if (outcome.error) {
      console.error(`${product} ${area}: call ended early: ${outcome.error.category}: ${outcome.error.message}`);
      process.exitCode = 1;
      continue;
    }
    save({ product, area, inputs, recordings: transport.recordings() });
  }
}
writeFileSync(idsPath, `${JSON.stringify(ids, null, 2)}\n`);
