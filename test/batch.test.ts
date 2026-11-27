import { describe, expect, it } from 'vitest';
import { LISTING_JSON, MISSING_LISTING_JSON, fakeTransport, ok, requestedListing, testClient } from './helpers.ts';


describe('Batch', () => {
  it('yields one Result per input, in completion order, and reports failures per item', async () => {
    const t = fakeTransport((req) => (requestedListing(req) === '2' ? ok(MISSING_LISTING_JSON) : ok(LISTING_JSON)));
    const { items, outcome } = await testClient(t).listings(['1', '2', '3']).all();
    expect(items).toHaveLength(3);
    expect(items.filter((r) => r.ok)).toHaveLength(2);
    const failed = items.find((r) => !r.ok)!;
    expect(failed.input).toBe('2');
    expect(!failed.ok && failed.error.category).toBe('NotFound');
    expect(outcome.error).toBeNull();
    expect(outcome.incomplete.map((i) => i.input)).toEqual(['2']);
    // The homepage, for the API key, then one request per listing.
    expect(outcome.requests).toBe(4);
  });

  it('marks inputs past maxRequests as BudgetExhausted without requesting them', async () => {
    const t = fakeTransport(() => ok(LISTING_JSON));
    const { items, outcome } = await testClient(t).listings(['1', '2', '3', '4'], { maxRequests: 3 }).all();
    expect(items).toHaveLength(4);
    // The homepage takes one of the three.
    expect(items.filter((r) => !r.ok && r.error.category === 'BudgetExhausted')).toHaveLength(2);
    expect(outcome.requests).toBe(3);
    expect(t.requests).toHaveLength(3);
  });

  it('ends the whole call on a block, reporting it in outcome without rejecting', async () => {
    const t = fakeTransport(() => ok('Access Denied', 403));
    const ids = Array.from({ length: 50 }, (_, i) => String(i));
    const batch = testClient(t, { limits: { concurrency: 1 } }).listings(ids);
    const items = [];
    for await (const r of batch.items()) items.push(r);
    const outcome = await batch.outcome();
    expect(outcome.error?.category).toBe('Blocked');
    expect(outcome.error?.name).toBe('BlockedError');
    expect(items.length).toBeLessThan(5);
    // The homepage, then the one blocked listing request.
    expect(t.requests.length).toBe(2);
  });

  it('retries transient failures, then reports Transient', async () => {
    const t = fakeTransport(() => ok('oops', 503));
    const { items, outcome } = await testClient(t).listings(['1']).all();
    expect(!items[0]!.ok && items[0]!.error.category).toBe('Transient');
    // The homepage, then the listing request and its three retries.
    expect(outcome.requests).toBe(5);
  });

  it('keeps the last exchange on an error, bodies included', async () => {
    const t = fakeTransport(() => ok('x'.repeat(1_500_000), 500));
    const { items } = await testClient(t).listings(['1']).all();
    const r = items[0]!;
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.exchange?.request.url).toContain('/api/v3/StaysPdpSections/');
    expect(r.error.exchange?.response?.status).toBe(500);
    expect(r.error.exchange?.response?.truncated).toBe(true);
    expect(r.error.exchange?.response?.body).toHaveLength(1_000_000);
  });

  it('stops on abort and reports Aborted', async () => {
    const ac = new AbortController();
    const t = fakeTransport(() => {
      ac.abort(new Error('user stop'));
      return ok(LISTING_JSON);
    });
    const outcome = await testClient(t, { limits: { concurrency: 1 } }).listings(['1', '2', '3'], { signal: ac.signal }).outcome();
    expect(outcome.error?.category).toBe('Aborted');
    expect(outcome.error!.cause).toEqual(new Error('user stop'));
  });

  it('outcome() before items() drains the items and never rejects', async () => {
    const t = fakeTransport(() => ok(LISTING_JSON));
    const batch = testClient(t).listings(['1', '2']);
    const outcome = await batch.outcome();
    expect(outcome.requests).toBe(3);
    expect(() => batch.items()).toThrow();
  });

  it('items() can be read once', () => {
    const batch = testClient(fakeTransport(() => ok(LISTING_JSON))).listings([]);
    batch.items();
    expect(() => batch.items()).toThrow();
  });

  it('pauses new requests while the buffer is unread', async () => {
    const t = fakeTransport(() => ok(LISTING_JSON));
    const ids = Array.from({ length: 100 }, (_, i) => String(i));
    const batch = testClient(t).listings(ids);
    const iterator = batch.items()[Symbol.asyncIterator]();
    await iterator.next();
    await new Promise((r) => setTimeout(r, 50));
    expect(t.requests.length).toBeLessThan(30);
    await iterator.return!();
  });

  it('takes a stream of inputs, so one call can feed another', async () => {
    const t = fakeTransport(() => ok(LISTING_JSON));
    const client = testClient(t);
    async function* ids() {
      yield '1';
      yield '2';
    }
    const { items } = await client.listings(ids()).all();
    expect(items.map((r) => r.input).sort()).toEqual(['1', '2']);
  });

  it('refuses limits above the defaults', () => {
    const t = fakeTransport(() => ok(LISTING_JSON));
    expect(() => testClient(t, { limits: { requestsPerSecond: 0 } })).toThrow();
    testClient(t, { limits: { requestsPerSecond: 50 } });
  });
});
