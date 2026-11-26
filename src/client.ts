import type { ClientContext } from './call.ts';
import { startBatch, startResultBatch } from './call.ts';
import { Scheduler } from './scheduler.ts';
import { systemClock, systemRandom } from './defaults.ts';
import { DEFAULT_CONCURRENCY, DEFAULT_REQUESTS_PER_SECOND } from './identity.ts';
import { DEFAULT_MONTHS, fetchCalendar } from './products/calendar.ts';
import { fetchListing } from './products/listing.ts';
import { fetchPriceQuote } from './products/priceQuote.ts';
import { fetchReviews } from './products/reviews.ts';
import { runSearch } from './products/search.ts';
import type { Client, ClientOptions, Transport } from './types.ts';


function lower(value: number | undefined, ceiling: number, name: string): number {
  if (value === undefined) return ceiling;
  if (!(value > 0)) throw new RangeError(`limits.${name} must be positive`);
  return Math.min(value, ceiling);
}

export function makeCreateClient(defaultTransport: (() => Transport) | null) {
  /** One client holds one request budget. Create one per process. */
  return function createClient(options: ClientOptions = {}): Client {
    const transport = options.transport ?? defaultTransport?.();
    if (!transport) {
      throw new TypeError('this runtime has no default transport: pass createClient({ transport })');
    }
    const clock = options.clock ?? systemClock();
    const rps = lower(options.limits?.requestsPerSecond, DEFAULT_REQUESTS_PER_SECOND, 'requestsPerSecond');
    const concurrency = Math.floor(lower(options.limits?.concurrency, DEFAULT_CONCURRENCY, 'concurrency')) || 1;
    let callIds = 0;
    const ctx: ClientContext = {
      transport,
      clock,
      random: options.random ?? systemRandom,
      scheduler: new Scheduler(clock, rps, concurrency),
      currency: options.currency ?? 'USD',
      concurrency,
      nextCallId: () => ++callIds,
      apiKey: { value: null, pending: null },
    };
    return {
      search: (queries, opts = {}) =>
        startBatch(ctx, opts, queries, (call, query, emit) => runSearch(ctx, call, query, emit)),
      listings: (ids, opts = {}) => startResultBatch(ctx, opts, ids, fetchListing),
      calendars: (ids, opts = {}) =>
        startResultBatch(ctx, opts, ids, (call, id) => fetchCalendar(call, id, opts.months ?? DEFAULT_MONTHS)),
      priceQuotes: (stays, opts = {}) => startResultBatch(ctx, opts, stays, fetchPriceQuote),
      reviews: (ids, opts = {}) =>
        startResultBatch(ctx, opts, ids, (call, id) => fetchReviews(call, id, opts.limit ?? 'all')),
    };
  };
}
