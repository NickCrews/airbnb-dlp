import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import type { TraceEvent } from '../src/types.ts';
import { fakeTransport, ok, testClient } from './helpers.ts';

const page = (() => {
  const fx = JSON.parse(gunzipSync(readFileSync(new URL('../fixtures/listings/austin-tx.json.gz', import.meta.url))).toString());
  return fx.recordings[0].response.body as string;
})();

describe('trace', () => {
  it('reports each call and each request with its status, size and classification', async () => {
    const events: TraceEvent[] = [];
    const t = fakeTransport((req) => (req.url.includes('/rooms/2?') ? ok('gone', 410) : ok(page)));
    await testClient(t, { trace: (e) => events.push(e) }).listings(['1', '2']).all();

    expect(events[0]).toMatchObject({ type: 'call.start', call: 1, product: 'listings' });
    expect(events.at(-1)).toMatchObject({ type: 'call.end', call: 1, product: 'listings', items: 2, requests: 2, incomplete: 1, error: null });
    const requests = events.filter((e) => e.type === 'request');
    expect(requests).toHaveLength(2);
    expect(new Set(requests.map((e) => e.request)).size).toBe(2);
    const responses = events.filter((e) => e.type === 'response');
    expect(responses.map((e) => e.status).sort()).toEqual([200, 410]);
    // The listing product reads a 410 itself, so the client does not classify it.
    expect(responses.find((e) => e.status === 410)).toMatchObject({ category: null, bytes: 4 });
    expect(responses.find((e) => e.status === 200)).toMatchObject({ category: null, bytes: page.length });
  });

  it('keeps a request number across its retries and reports each backoff', async () => {
    const events: TraceEvent[] = [];
    const t = fakeTransport(() => ok('oops', 503));
    await testClient(t, { trace: (e) => events.push(e) }).listings(['1']).all();

    const requests = events.filter((e) => e.type === 'request');
    expect(requests.map((e) => e.attempt)).toEqual([0, 1, 2, 3]);
    expect(new Set(requests.map((e) => e.request)).size).toBe(1);
    const retries = events.filter((e) => e.type === 'retry');
    expect(retries).toHaveLength(3);
    expect(retries.every((e) => e.category === 'Transient' && e.delayMs > 0)).toBe(true);
  });

  it('reports a block as the call ending early', async () => {
    const events: TraceEvent[] = [];
    const t = fakeTransport(() => ok('Access Denied', 429));
    await testClient(t, { trace: (e) => events.push(e), limits: { concurrency: 1 } }).listings(['1', '2', '3']).all();

    expect(events.find((e) => e.type === 'response')).toMatchObject({ status: 429, category: 'Blocked' });
    expect(events.at(-1)).toMatchObject({ type: 'call.end', error: 'Blocked' });
  });

  it('ignores a tracer that throws', async () => {
    const t = fakeTransport(() => ok(page));
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
    const t = fakeTransport(() => (n++ === 0 ? limited({ 'retry-after': '3' }) : ok(page)));
    const { items, outcome } = await testClient(t, { trace: (e) => events.push(e) }).listings(['1']).all();
    expect(items[0]!.ok).toBe(true);
    expect(outcome.error).toBeNull();
    expect(events.find((e) => e.type === 'pace')).toMatchObject({ reason: 'rate-limited', pauseMs: 3000, requestsPerSecond: 1 });
    expect(events.find((e) => e.type === 'retry')).toMatchObject({ delayMs: 3000, category: 'Blocked' });
  });

  it('ends the call as Blocked after three rate limits on one request', async () => {
    const t = fakeTransport(() => limited());
    const { outcome } = await testClient(t, { limits: { concurrency: 1 } }).listings(['1', '2']).all();
    expect(outcome.error?.category).toBe('Blocked');
    expect(t.requests).toHaveLength(4);
  });

  it('ends the call at once when Retry-After asks for more than a minute', async () => {
    const t = fakeTransport(() => limited({ 'retry-after': '600' }));
    const { outcome } = await testClient(t).listings(['1']).all();
    expect(outcome.error?.category).toBe('Blocked');
    expect(t.requests).toHaveLength(1);
  });

  it('ends the call at once on a challenge page, whatever its status', async () => {
    const t = fakeTransport(() => ({ status: 429, headers: {}, body: '<script src="/_sec/cp_challenge/x.js"></script>' }));
    const { outcome } = await testClient(t).listings(['1']).all();
    expect(outcome.error?.category).toBe('Blocked');
    expect(t.requests).toHaveLength(1);
  });
});
