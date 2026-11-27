import { describe, expect, it } from 'vitest';
import type { TraceEvent } from '../src/types.ts';
import { LISTING_JSON, MISSING_LISTING_JSON, fakeTransport, ok, requestedListing, testClient } from './helpers.ts';


describe('trace', () => {
  it('reports each call and each request with its status, size and classification', async () => {
    const events: TraceEvent[] = [];
    const t = fakeTransport((req) => (requestedListing(req) === '2' ? ok(MISSING_LISTING_JSON) : ok(LISTING_JSON)));
    await testClient(t, { trace: (e) => events.push(e) }).listings(['1', '2']).all();

    expect(events[0]).toMatchObject({ type: 'call.start', call: 1, product: 'listings' });
    // The homepage, for the API key, then one request per listing.
    expect(events.at(-1)).toMatchObject({ type: 'call.end', call: 1, product: 'listings', items: 2, requests: 3, incomplete: 1, error: null });
    const requests = events.filter((e) => e.type === 'request');
    expect(requests.map((e) => new URL(e.url).pathname.split('/')[3] ?? new URL(e.url).pathname)).toEqual(['/', 'StaysPdpSections', 'StaysPdpSections']);
    expect(new Set(requests.map((e) => e.request)).size).toBe(3);
    const responses = events.filter((e) => e.type === 'response');
    expect(responses.every((e) => e.status === 200 && e.category === null)).toBe(true);
    expect(responses.some((e) => e.bytes === LISTING_JSON.length)).toBe(true);
  });

  it('keeps a request number across its retries and reports each backoff', async () => {
    const events: TraceEvent[] = [];
    const t = fakeTransport(() => ok('oops', 503));
    await testClient(t, { trace: (e) => events.push(e) }).listings(['1']).all();

    const requests = events.filter((e) => e.type === 'request' && e.url.includes('/StaysPdpSections/'));
    expect(requests.map((e) => e.type === 'request' && e.attempt)).toEqual([0, 1, 2, 3]);
    expect(new Set(requests.map((e) => e.type === 'request' && e.request)).size).toBe(1);
    const retries = events.filter((e) => e.type === 'retry');
    expect(retries).toHaveLength(3);
    expect(retries.every((e) => e.category === 'Transient' && e.delayMs > 0)).toBe(true);
  });

  it('reports a block as the call ending early', async () => {
    const events: TraceEvent[] = [];
    const t = fakeTransport(() => ok('Access Denied', 403));
    await testClient(t, { trace: (e) => events.push(e), limits: { concurrency: 1 } }).listings(['1', '2', '3']).all();

    expect(events.find((e) => e.type === 'response' && e.status === 403)).toMatchObject({ category: 'Blocked' });
    expect(events.at(-1)).toMatchObject({ type: 'call.end', error: 'Blocked' });
  });

  it('ignores a tracer that throws', async () => {
    const t = fakeTransport(() => ok(LISTING_JSON));
    const { items } = await testClient(t, {
      trace: () => {
        throw new Error('tracer bug');
      },
    })
      .listings(['1'])
      .all();
    expect(items[0]!.ok).toBe(true);
  });
});

describe('rate limits', () => {
  const limited = (headers: Record<string, string> = {}) => ({ status: 429, headers, body: '<html>Too many requests</html>' });

  it('waits out a 429, slows the client, and retries', async () => {
    const events: TraceEvent[] = [];
    let n = 0;
    const t = fakeTransport(() => (n++ === 0 ? limited({ 'retry-after': '3' }) : ok(LISTING_JSON)));
    const { items, outcome } = await testClient(t, { trace: (e) => events.push(e) }).listings(['1']).all();
    expect(items[0]!.ok).toBe(true);
    expect(outcome.error).toBeNull();
    // The homepage's healthy response sped the pace up 10% from 2 before the 429 halved it.
    expect(events.find((e) => e.type === 'pace' && e.reason === 'rate-limited')).toMatchObject({ pauseMs: 3000, requestsPerSecond: 1.1 });
    expect(events.find((e) => e.type === 'retry')).toMatchObject({ delayMs: 3000, category: 'Blocked' });
  });

  it('ends the call as Blocked after three rate limits on one request', async () => {
    const t = fakeTransport(() => limited());
    const { outcome } = await testClient(t, { limits: { concurrency: 1 } }).listings(['1', '2']).all();
    expect(outcome.error?.category).toBe('Blocked');
    // The homepage, then the listing request and its three retries.
    expect(t.requests).toHaveLength(5);
  });

  it('ends the call at once when Retry-After asks for more than a minute', async () => {
    const t = fakeTransport(() => limited({ 'retry-after': '600' }));
    const { outcome } = await testClient(t).listings(['1']).all();
    expect(outcome.error?.category).toBe('Blocked');
    expect(t.requests).toHaveLength(2);
  });

  it("treats the API's 401 as its throttle: waits it out from 10 s, then retries", async () => {
    const events: TraceEvent[] = [];
    let n = 0;
    const t = fakeTransport(() => (n++ < 2 ? { status: 401, headers: {}, body: '{"error":"unauthorized"}' } : ok(LISTING_JSON)));
    const { items, outcome } = await testClient(t, { trace: (e) => events.push(e) }).listings(['1']).all();
    expect(items[0]!.ok).toBe(true);
    expect(outcome.error).toBeNull();
    expect(events.filter((e) => e.type === 'pace' && e.reason === 'rate-limited').map((e) => e.type === 'pace' && e.pauseMs)).toEqual([10_000, 20_000]);
  });

  it('ends the call as Blocked when the API keeps answering 401', async () => {
    const t = fakeTransport(() => ({ status: 401, headers: {}, body: '{"error":"unauthorized"}' }));
    const { outcome } = await testClient(t, { limits: { concurrency: 1 } }).listings(['1', '2']).all();
    expect(outcome.error?.category).toBe('Blocked');
    // The homepage, then the listing request and its three retries.
    expect(t.requests).toHaveLength(5);
  });

  it('ends the call at once on a challenge page, whatever its status', async () => {
    const t = fakeTransport(() => ({ status: 429, headers: {}, body: '<script src="/_sec/cp_challenge/x.js"></script>' }));
    const { outcome } = await testClient(t).listings(['1']).all();
    expect(outcome.error?.category).toBe('Blocked');
    expect(t.requests).toHaveLength(2);
  });
});
