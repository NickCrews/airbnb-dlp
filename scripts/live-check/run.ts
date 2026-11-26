/**
 * The live check: runs every product against airbnb.com and decides whether
 * the library still works. `pnpm live-check [--small] [--history <dir>] [--out <dir>]`.
 *
 * --small    the pull-request set: one area, fewer samples.
 * --history  reports from earlier runs (one JSON per run), for baselines and persistence.
 * --out      where to write report.json and, on failure, recordings.json.gz.
 *
 * Exit code 0 when every check passes, 1 otherwise. The report names each
 * failure's category; file-issues.ts turns it into issues.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { bookableStays, createClient } from '../../src/entry-native.ts';
import type { AirbnbError, ErrorCategory } from '../../src/errors.ts';
import { recordingTransport } from '../../src/testing/index.ts';
import { impitTransport } from '../../src/transport/impit.ts';
import type { BBox, Client, Listing, Outcome, Result, SearchHit, SearchQuery, Stay } from '../../src/types.ts';
import { inBox } from '../../src/products/search.ts';
import { safeToday, addDays } from '../../src/dates.ts';
import { type Area, type Failure, type Report, loadContract, loadHistory, sampleEvenly } from './contract.ts';
import { checkFillRates, fillRates } from './fill-rates.ts';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const small = args.includes('--small');
const outDir = flag('--out') ?? '.live-check';
const history = loadHistory(flag('--history'));
const { areas: allAreas, thresholds } = loadContract();
// The pull-request set searches only the rural area, which one small budget covers completely.
const areas = small ? allAreas.filter((a) => a.kind === 'rural').slice(0, 1) : allAreas;
const perArea = small ? 4 : thresholds.sampleListingsPerArea;

const transport = recordingTransport(impitTransport());
const client: Client = createClient({
  transport,
  limits: { requestsPerSecond: thresholds.requestsPerSecond },
});
const startedAt = new Date().toISOString();
const today = safeToday(Date.now());
const failures: Failure[] = [];
let requests = 0;
let blocked: AirbnbError | null = null;

function remaining(): number {
  return thresholds.requestBudget - requests;
}

function fail(category: ErrorCategory, check: string, message: string, detail?: string): void {
  failures.push(detail === undefined ? { category, check, message } : { category, check, message, detail });
}

/**
 * Requests each stage may make. Together they stay within the run budget of
 * 150, with the fully searched area taking the largest share. The API key
 * request is counted in the first stage.
 */
const ALLOWANCE = {
  fullSearch: 43,
  areaSearch: 9,
  coverage: 1,
  filterSearch: 3,
  filterPages: 2,
  listings: 8,
  calendars: 8,
  priceQuotes: 8,
  reviews: 8,
};

/** Runs one call within its allowance and the run's remaining budget; a block stops the whole run. */
async function run<I, T>(name: string, allowance: number, start: (maxRequests: number) => { all(): Promise<{ items: T[]; outcome: Outcome<I> }> }): Promise<{ items: T[]; outcome: Outcome<I> } | null> {
  if (blocked) return null;
  const budget = Math.min(allowance, remaining());
  if (budget <= 0) {
    fail('Unknown', name, 'the run budget is spent; the live check needs fewer requests');
    return null;
  }
  const result = await start(budget).all();
  requests += result.outcome.requests;
  if (result.outcome.error?.category === 'Blocked') {
    blocked = result.outcome.error;
    fail('Blocked', name, 'Airbnb blocked the run', result.outcome.error.message);
  } else if (result.outcome.error) {
    fail(result.outcome.error.category, name, 'the call ended early', result.outcome.error.message);
  }
  return result;
}

function successShare<I, T>(name: string, items: Result<I, T>[], min: number): void {
  if (items.length === 0) return;
  const okCount = items.filter((r) => r.ok).length;
  if (okCount / items.length < min) {
    const errors = items.flatMap((r) => (r.ok ? [] : [r.error]));
    const category = mostCommon(errors.map((e) => e.category));
    fail(category, `${name}.success`, `${okCount} of ${items.length} succeeded (minimum share ${min})`, errors[0]?.message);
  }
}

function mostCommon(categories: ErrorCategory[]): ErrorCategory {
  const counts = new Map<ErrorCategory, number>();
  for (const c of categories) counts.set(c, (counts.get(c) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'Unknown';
}

const pad = (box: BBox, deg: number): BBox => ({ south: box.south - deg, north: box.north + deg, west: box.west - deg, east: box.east + deg });

// ---------------------------------------------------------------- search per area

const hitsByArea = new Map<string, SearchHit[]>();
const fullArea = areas.find((a) => a.kind === 'rural') ?? areas[0]!;
// The fully searched area goes first, so the coverage audit has a complete set to check against.
for (const area of [fullArea, ...areas.filter((a) => a !== fullArea)]) {
  // Other areas search one price band, enough to reach their minimum count on a small allowance.
  const query: SearchQuery = area === fullArea ? { area: { bbox: area.bbox } } : { area: { bbox: area.bbox }, nightlyPrice: { min: 100, max: 200 } };
  const allowance = area === fullArea ? ALLOWANCE.fullSearch : ALLOWANCE.areaSearch;
  const result = await run(`search.${area.id}`, allowance, (maxRequests) => client.search([query], { maxRequests }));
  if (!result) continue;
  const hits = result.items;
  hitsByArea.set(area.id, hits);
  for (const { error } of result.outcome.incomplete) {
    if (error.category === 'BudgetExhausted' && area !== fullArea) continue;
    fail(error.category === 'BudgetExhausted' ? 'Unknown' : error.category, `search.${area.id}.complete`, 'the search did not cover the whole area', error.message);
  }
  if (hits.length < area.minListings) {
    fail('ResponseChanged', `search.${area.id}.count`, `${hits.length} listings found, minimum ${area.minListings}`);
  }
  const outside = hits.filter((h) => h.listing.location && !inBox(pad(area.bbox, 0.01), h.listing.location.lat, h.listing.location.lng));
  if (outside.length > 0) fail('ResponseChanged', `search.${area.id}.coordinates`, `${outside.length} listings outside the area`);
  const priced = hits.filter((h) => h.listing.price?.total);
  if (hits.length > 0 && priced.length / hits.length < thresholds.starting.searchCardsWithPrice) {
    fail('ResponseChanged', `search.${area.id}.price`, `${priced.length} of ${hits.length} cards have a parsed price`);
  }
  const { min, max } = thresholds.ranges.nightlyPriceUsd;
  const badPrice = hits.filter((h) => h.listing.price?.nightly && (h.listing.price.nightly.amount < min || h.listing.price.nightly.amount > max));
  if (badPrice.length > 0) fail('ResponseChanged', `search.${area.id}.priceRange`, `${badPrice.length} nightly prices outside ${min}-${max}`);
}

// ---------------------------------------------------------------- coverage audit

{
  const hits = hitsByArea.get(fullArea.id) ?? [];
  const found = new Set(hits.map((h) => h.listing.id));
  const centres = sampleEvenly(hits.filter((h) => h.listing.location), small ? 1 : thresholds.coverage.auditBoxes);
  let seen = 0;
  let missed = 0;
  for (const centre of centres) {
    const { lat, lng } = centre.listing.location!;
    const box = { south: lat - 0.005, north: lat + 0.005, west: lng - 0.01, east: lng + 0.01 };
    const result = await run('coverage', ALLOWANCE.coverage, (maxRequests) => client.search([{ area: { bbox: box } }], { maxRequests }));
    if (!result || result.outcome.incomplete.length > 0) continue;
    for (const hit of result.items) {
      if (!hit.listing.location || !inBox(fullArea.bbox, hit.listing.location.lat, hit.listing.location.lng)) continue;
      seen++;
      if (!found.has(hit.listing.id)) missed++;
    }
  }
  if (seen > 0 && missed / seen > thresholds.coverage.maxMissShare) {
    fail('ResponseChanged', 'search.coverage', `${missed} of ${seen} listings in audit boxes were missed by the full search`);
  }
}

// ---------------------------------------------------------------- filters

/** Each filter whose effect the library can read back from search cards or listing pages. */
// The whole dense area in a narrow price band: enough listings for every filter, few enough to fit on a page or two.
const filterArea = allAreas.find((a) => a.kind === 'dense') ?? allAreas[0]!;
const filterBox = filterArea.bbox;
const FILTER_BAND = { min: 100, max: 105 };
const FILTERS: { name: string; query: Partial<SearchQuery>; card?: (h: SearchHit) => boolean; page?: (l: Listing) => boolean }[] = [
  {
    name: 'nightlyPrice',
    query: { nightlyPrice: { min: 100, max: 110 } },
    // Card prices include fees; the filter applies before them.
    card: (h) => !h.listing.price?.nightly || (h.listing.price.nightly.amount >= 80 && h.listing.price.nightly.amount <= 200),
  },
  // Three-bedroom homes are rare in the cheap band, so this filter uses a higher one.
  { name: 'minBedrooms', query: { minBedrooms: 3, nightlyPrice: { min: 250, max: 260 } }, page: (l) => l.bedrooms?.count == null || l.bedrooms.count >= 3 },
  { name: 'propertyGroups', query: { propertyGroups: ['apartment'] }, page: (l) => l.propertyType === null || ['APARTMENT', 'CONDOMINIUM', 'SERVICED_APARTMENT', 'LOFT'].includes(l.propertyType) },
];
for (const filter of small ? FILTERS.slice(0, 2) : FILTERS) {
  const query: SearchQuery = { area: { bbox: filterBox }, nightlyPrice: FILTER_BAND, ...filter.query };
  const result = await run(`filter.${filter.name}`, ALLOWANCE.filterSearch, (maxRequests) => client.search([query], { maxRequests }));
  if (!result) continue;
  if (result.items.length === 0) {
    fail('ResponseChanged', `filter.${filter.name}`, 'the filtered search returned no listings');
    continue;
  }
  if (filter.card) {
    const bad = result.items.filter((h) => !filter.card!(h));
    if (bad.length > 0) fail('ResponseChanged', `filter.${filter.name}`, `${bad.length} of ${result.items.length} results do not satisfy the filter`);
  }
  if (filter.page) {
    const ids = sampleEvenly(result.items, 2).map((h) => h.listing.id);
    const pages = await run(`filter.${filter.name}.pages`, ALLOWANCE.filterPages, (maxRequests) => client.listings(ids, { maxRequests }));
    const bad = (pages?.items ?? []).flatMap((r) => (r.ok && !filter.page!(r.value) ? [r.value.id] : []));
    if (bad.length > 0) fail('ResponseChanged', `filter.${filter.name}`, `listings ${bad.join(', ')} do not satisfy the filter`);
  }
}

// ---------------------------------------------------------------- fetches on sampled listings

const listingResults: Result<string, Listing>[] = [];
const sampled = new Map<Area, string[]>();
for (const area of areas) {
  const ids = sampleEvenly(hitsByArea.get(area.id) ?? [], perArea).map((h) => h.listing.id);
  sampled.set(area, ids);
  const result = await run(`listings.${area.id}`, ALLOWANCE.listings, (maxRequests) => client.listings(ids, { maxRequests }));
  if (result) listingResults.push(...result.items);
}
successShare('listings', listingResults, thresholds.fetchSuccessShare.listings);

const twoPerArea = [...sampled.values()].flatMap((ids) => ids.slice(0, small ? 1 : 2));
const calendars = await run('calendars', ALLOWANCE.calendars, (maxRequests) => client.calendars(twoPerArea, { maxRequests }));
if (calendars) {
  successShare('calendars', calendars.items, thresholds.fetchSuccessShare.calendars);
  const last = addDays(today, thresholds.ranges.calendarMonths * 31 + 2);
  for (const r of calendars.items) {
    if (!r.ok) continue;
    const bad = r.value.days.filter((d) => d.date < today || d.date > last);
    if (bad.length > 0) fail('ResponseChanged', 'calendars.range', `listing ${r.value.id}: ${bad.length} days outside the next 12 months`);
    if (r.value.days.length < 300) fail('ResponseChanged', 'calendars.length', `listing ${r.value.id}: only ${r.value.days.length} days`);
  }
}

const stays: Stay[] = [];
for (const r of calendars?.items ?? []) {
  if (!r.ok) continue;
  const first = bookableStays(r.value, addDays(today, 2))[Symbol.iterator]().next();
  if (!first.done) stays.push(first.value);
}
const quotes = await run('priceQuotes', ALLOWANCE.priceQuotes, (maxRequests) => client.priceQuotes(stays, { maxRequests }));
if (quotes) {
  successShare('priceQuotes', quotes.items, thresholds.fetchSuccessShare.priceQuotes);
  const { min, max } = thresholds.ranges.nightlyPriceUsd;
  for (const r of quotes.items) {
    if (!r.ok) continue;
    const nights = (Date.parse(r.input.checkOut) - Date.parse(r.input.checkIn)) / 86_400_000;
    const nightly = r.value.total.amount / nights;
    if (nightly < min || nightly > max) fail('ResponseChanged', 'priceQuotes.range', `listing ${r.input.id}: ${nightly.toFixed(2)} a night`);
  }
}

const reviews = await run('reviews', ALLOWANCE.reviews, (maxRequests) => client.reviews(twoPerArea, { limit: 24, maxRequests }));
if (reviews) {
  successShare('reviews', reviews.items, thresholds.fetchSuccessShare.reviews);
  const now = Date.now();
  for (const r of reviews.items) {
    if (!r.ok) continue;
    const future = r.value.reviews.filter((v) => Date.parse(v.createdAt) > now + 86_400_000);
    if (future.length > 0) fail('ResponseChanged', 'reviews.range', `listing ${r.value.id}: ${future.length} reviews dated in the future`);
  }
}

// ---------------------------------------------------------------- fill rates

const listings = listingResults.flatMap((r) => (r.ok ? [r.value] : []));
for (const area of areas) {
  const ids = new Set(sampled.get(area));
  const areaListings = listings.filter((l) => ids.has(l.id));
  const box = pad(area.bbox, 0.01);
  const outside = areaListings.filter((l) => l.location && !inBox(box, l.location.lat, l.location.lng));
  if (outside.length > 0) fail('ResponseChanged', `listings.${area.id}.coordinates`, `${outside.length} listing pages place the listing outside the area`);
}
const rates = fillRates(listings, areas, sampled);
if (!blocked) failures.push(...checkFillRates(rates, history, thresholds));

// ---------------------------------------------------------------- report

const report: Report = {
  startedAt,
  finishedAt: new Date().toISOString(),
  small,
  requests,
  passed: failures.length === 0,
  failures,
  fillRates: blocked ? null : rates,
};
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
if (!report.passed) writeFileSync(join(outDir, 'recordings.json.gz'), gzipSync(JSON.stringify(transport.recordings())));
console.log(`${requests} requests; ${failures.length} failures`);
for (const f of failures) console.log(`  [${f.category}] ${f.check}: ${f.message}`);
process.exitCode = report.passed ? 0 : 1;
