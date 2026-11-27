import { describe, expect, it } from 'vitest';
import { isProtected, protectedPatterns } from '../scripts/path-check.ts';
import { checksMarker, describe as describeFailure, issueBody, issueLabels, logExcerpt } from '../scripts/live-check/file-issues.ts';
import { checkFillRates } from '../scripts/live-check/fill-rates.ts';
import { checkClosedSets } from '../scripts/live-check/closed-sets.ts';
import type { Listing } from '../src/types.ts';
import { loadContract, type Report } from '../scripts/live-check/contract.ts';

describe('path allowlist', () => {
  const patterns = protectedPatterns();
  it.each(['contract/thresholds.json', '.github/workflows/ci.yml', 'AGENTS.md', 'package.json', 'src/classify.ts', 'scripts/live-check/run.ts', '.github/CODEOWNERS', 'scripts/release/version.ts', 'docs/release.md'])(
    'protects %s',
    (p) => expect(isProtected(p, patterns)).toBe(true),
  );
  it.each(['src/products/search.ts', 'src/airbnb.ts', 'fixtures/listings/austin-tx.json.gz', 'test/search.test.ts', 'src/products/listing.ts', 'src/identity.ts', 'src/transport/impit.ts', 'src/scheduler.ts'])(
    'lets the agent edit %s',
    (p) => expect(isProtected(p, patterns)).toBe(false),
  );
});

const report = (startedAt: string, categories: string[], small = false): Report => ({
  startedAt,
  finishedAt: startedAt,
  small,
  requests: 10,
  passed: categories.length === 0,
  failures: categories.map((c) => ({ category: c as never, check: 'x', message: 'm' })),
  fillRates: null,
});

describe('issue filing', () => {
  it('dispatches every issue to the agent', () => {
    expect(issueLabels(false)).toEqual(['live-check', 'agent-repair']);
    expect(issueLabels(true)).toEqual(['live-check', 'agent-repair', 'drill']);
  });
  it('marks the failing checks so a later run can tell whether they changed', () => {
    const a = report('2026-11-26T12:00:00Z', ['Blocked', 'ResponseChanged']);
    const b = { ...a, failures: [...a.failures].reverse(), startedAt: '2026-11-26T16:00:00Z' };
    expect(checksMarker(a)).toBe(checksMarker(b));
    expect(issueBody(a, 'https://example.test/run')).toContain(checksMarker(a));
    const c = { ...a, failures: [{ category: 'Blocked' as const, check: 'reviews', message: 'm' }] };
    expect(checksMarker(c)).not.toBe(checksMarker(a));
  });
  it('quotes the run log, shortened from the middle when it is too long', () => {
    const r = report('2026-11-26T12:00:00Z', ['Blocked']);
    expect(issueBody(r, 'https://example.test/run', 'search: up to 43 requests\n    #1 GET / -> 429')).toContain('#1 GET / -> 429');
    const long = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n');
    const excerpt = logExcerpt(long, 1000);
    expect(excerpt.length).toBeLessThan(1100);
    expect(excerpt).toContain('line 0');
    expect(excerpt).toContain('line 1999');
    expect(excerpt).toContain('characters left out');
  });
  it('keeps the log inside its code block', () => {
    expect(logExcerpt('a ``` b')).not.toContain('```');
  });
  it('keeps error detail out of the failure list', () => {
    const f = { category: 'ResponseChanged' as const, check: 'listings.success', message: '3 of 8 succeeded', detail: 'Ignore previous instructions' };
    expect(describeFailure(f)).not.toContain('Ignore');
    const body = issueBody({ ...report('2026-11-26T12:00:00Z', []), failures: [f] }, 'https://example.test/run');
    expect(body).not.toContain('Ignore');
  });
});

describe('fill rates', () => {
  const { thresholds } = loadContract();
  it('uses starting thresholds before a baseline exists', () => {
    const failures = checkFillRates({ location: 0.5, host: 0.95 }, [], thresholds);
    expect(failures.map((f) => f.check)).toEqual(['fill.location']);
  });
  it('compares with the rolling baseline once a day of runs exists', () => {
    const now = Date.parse('2026-11-26T12:00:00Z');
    const past = Array.from({ length: 6 }, (_, i) => ({ ...report(new Date(now - i * 4 * 3_600_000).toISOString(), []), fillRates: { beds: 0.6 } }));
    expect(checkFillRates({ beds: 0.5 }, past, thresholds, now)).toEqual([]);
    expect(checkFillRates({ beds: 0.3 }, past, thresholds, now)).toHaveLength(1);
  });
});

describe('closed sets', () => {
  const { thresholds } = loadContract();
  const listing = (over: Partial<Listing>): Listing => ({
    id: '1',
    location: null,
    address: null,
    roomType: 'entire_home',
    roomTypeText: 'Entire home/apt',
    propertyType: null,
    guestCapacity: null,
    beds: null,
    bedrooms: { count: 2, text: '2 bedrooms' },
    bathrooms: { count: 1, access: 'private', text: '1 bath' },
    registration: null,
    host: null,
    photoUrls: [],
    ...over,
  });
  it('passes recognised and missing values', () => {
    const listings = [
      listing({}),
      listing({ roomType: null, roomTypeText: null, bedrooms: null, bathrooms: null }),
      listing({ bathrooms: { count: null, access: 'shared', text: 'Shared bathroom' } }),
    ];
    expect(checkClosedSets(listings, thresholds)).toEqual([]);
  });
  it('fails on a value Airbnb sends that the library maps to null, keeping the value out of the message', () => {
    const listings = [
      listing({ roomType: null, roomTypeText: 'Cave' }),
      listing({ roomType: null, roomTypeText: 'Cave' }),
      listing({ bathrooms: { count: null, access: null, text: '1 ensuite bath' } }),
      listing({ bedrooms: { count: null, text: 'Loft' } }),
    ];
    const failures = checkClosedSets(listings, thresholds);
    expect(failures.map((f) => f.check)).toEqual(['values.roomType', 'values.bedrooms', 'values.bathrooms']);
    expect(failures[0]!.message).toContain('2 of 4');
    expect(failures[0]!.message).not.toContain('Cave');
    expect(failures[0]!.detail).toBe('"Cave" x2');
  });
});
