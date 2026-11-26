/**
 * The fixture suite: replays every recorded fixture through the client and
 * checks the results. It imports nothing runtime-specific, so the same suite
 * runs on Node, Bun, Deno and in a browser.
 */
import { makeCreateClient } from '../src/client.ts';
import type { Recording } from '../src/testing/index.ts';
import { replayTransport } from '../src/testing/index.ts';
import type { Clock, Outcome } from '../src/types.ts';

export type Product = 'search' | 'listings' | 'calendars' | 'priceQuotes' | 'reviews';

export interface Fixture {
  product: Product;
  area: string;
  inputs: unknown[];
  recordings: Recording[];
}

export const RECORD_OPTIONS = {
  calendars: { months: 3 },
  reviews: { limit: 30 },
} as const;

/** A clock whose sleeps finish at once and move time forward, so replay is fast and deterministic. */
export function instantClock(startMs: number): Clock {
  let now = startMs;
  return {
    now: () => now,
    async sleep(ms, signal) {
      if (signal.aborted) throw signal.reason;
      now += Math.max(0, ms);
      await Promise.resolve();
    },
  };
}

/** Problems with a fixture file itself: anything that is not a complete recording. */
export function incompleteRecordings(fixture: Fixture): string[] {
  const problems: string[] = [];
  if (!Array.isArray(fixture.recordings) || fixture.recordings.length === 0) problems.push('no recordings');
  for (const [i, r] of (fixture.recordings ?? []).entries()) {
    const where = `recording ${i}`;
    if (typeof r.recordedAt !== 'string' || Number.isNaN(Date.parse(r.recordedAt))) problems.push(`${where}: no recordedAt`);
    const q = r.request;
    if (!q || (q.method !== 'GET' && q.method !== 'POST') || typeof q.url !== 'string' || typeof q.headers !== 'object' || (q.body !== null && typeof q.body !== 'string')) {
      problems.push(`${where}: incomplete request`);
    }
    const s = r.response;
    if (!s || typeof s.status !== 'number' || typeof s.headers !== 'object' || typeof s.body !== 'string') {
      problems.push(`${where}: incomplete response`);
    }
  }
  return problems;
}

/** Result categories a fixture may legitimately contain. */
const EXPECTED_FAILURES = new Set(['NotFound', 'StayUnavailable']);

export async function replayFixture(fixture: Fixture): Promise<{ outcome: Outcome<unknown>; items: unknown[]; problems: string[] }> {
  const problems = incompleteRecordings(fixture).map((p) => `${fixture.product}/${fixture.area}: ${p}`);
  const start = Date.parse(fixture.recordings[0]?.recordedAt ?? '2000-01-01T00:00:00Z');
  const createClient = makeCreateClient(null);
  const client = createClient({ transport: replayTransport(fixture.recordings), clock: instantClock(start), random: () => 0.5 });
  const inputs = fixture.inputs as never[];
  const batch =
    fixture.product === 'search'
      ? client.search(inputs)
      : fixture.product === 'listings'
        ? client.listings(inputs)
        : fixture.product === 'calendars'
          ? client.calendars(inputs, RECORD_OPTIONS.calendars)
          : fixture.product === 'priceQuotes'
            ? client.priceQuotes(inputs)
            : client.reviews(inputs, RECORD_OPTIONS.reviews);
  const { items, outcome } = await (batch as { all(): Promise<{ items: unknown[]; outcome: Outcome<unknown> }> }).all();
  const label = `${fixture.product}/${fixture.area}`;
  if (outcome.error) problems.push(`${label}: call ended with ${outcome.error.category}: ${outcome.error.message}`);
  if (fixture.product === 'search') {
    if (items.length === 0) problems.push(`${label}: no search hits`);
    for (const { error } of outcome.incomplete) problems.push(`${label}: incomplete: ${error.category}: ${error.message}`);
  } else {
    if (items.length !== fixture.inputs.length) problems.push(`${label}: ${items.length} results for ${fixture.inputs.length} inputs`);
    for (const r of items as { ok: boolean; error?: { category: string; message: string } }[]) {
      if (!r.ok && !EXPECTED_FAILURES.has(r.error!.category)) {
        problems.push(`${label}: ${r.error!.category}: ${r.error!.message}`);
      }
    }
  }
  return { outcome, items, problems };
}

export async function runFixtureSuite(fixtures: Fixture[]): Promise<string[]> {
  const problems: string[] = [];
  for (const fixture of fixtures) problems.push(...(await replayFixture(fixture)).problems);
  return problems;
}
