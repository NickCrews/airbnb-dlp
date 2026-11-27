/**
 * The listing page parser against a real recorded page, altered the ways
 * Airbnb's pages could change: each layer must keep working when another
 * breaks. The client fetches StaysPdpSections instead of the page, so the
 * page lives in test/data rather than fixtures/.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { parseListingPage } from '../src/products/listing.ts';
import { MarkerMissingError } from '../src/parse-errors.ts';

const fixture = JSON.parse(gunzipSync(readFileSync(new URL('./data/listing-page-anchorage-ak.json.gz', import.meta.url))).toString());
const page = fixture.recordings[0].response.body as string;
const id = fixture.inputs[0] as string;
const baseline = parseListingPage(id, page);

describe('listing page parser', () => {
  it('reads every field from the recorded page', () => {
    expect(baseline.location).not.toBeNull();
    expect(baseline.roomType).not.toBeNull();
    expect(baseline.guestCapacity).not.toBeNull();
    expect(baseline.host?.timeAsHost).not.toBeNull();
    expect(baseline.photoUrls.length).toBeGreaterThan(0);
  });

  it('survives a renamed exact-location flag', () => {
    const changed = parseListingPage(id, page.replaceAll('"isExactLocation"', '"hasExactLocation"'));
    expect(changed.location).toEqual(baseline.location);
  });

  it('survives renamed script ids and wrappers', () => {
    const changed = parseListingPage(id, page.replaceAll('data-deferred-state-0', 'data-state-x').replaceAll('niobeClientData', 'apolloState'));
    expect(changed).toEqual(baseline);
  });

  it('falls back to JSON-LD and raw patterns when the embedded JSON does not parse', () => {
    const broken = page.replace(/(<script\b[^>]*id="data-deferred-state-0"[^>]*>)\{/, '$1{,');
    const changed = parseListingPage(id, broken);
    expect(changed.location?.lat).toBeCloseTo(baseline.location!.lat, 3);
    expect(changed.location?.exact).toBe(baseline.location!.exact);
    expect(changed.roomType).toBe(baseline.roomType);
    expect(changed.guestCapacity).toBe(baseline.guestCapacity);
    expect(changed.beds).toBe(baseline.beds);
    expect(changed.host?.id).toBe(baseline.host?.id);
  });

  it('treats a page with no listing data as a bot page', () => {
    expect(() => parseListingPage(id, '<html><body>Please verify you are a human</body></html>')).toThrow(MarkerMissingError);
  });
});
