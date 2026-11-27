/**
 * The listing parser against a real recorded StaysPdpSections response,
 * altered the ways Airbnb's response could change: fields are found by key
 * name and shape, so renamed wrappers and moved sections must not break them.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { isMissingListing, parseListing } from '../src/products/listing.ts';
import type { Listing } from '../src/types.ts';
import { MarkerMissingError } from '../src/parse-errors.ts';

const fixture = JSON.parse(gunzipSync(readFileSync(new URL('../fixtures/listings/anchorage-ak.json.gz', import.meta.url))).toString());
const body = (fixture.recordings as { request: { url: string }; response: { body: string } }[]).find((r) =>
  r.request.url.includes('/StaysPdpSections/'),
)!.response.body;
const id = fixture.inputs[0] as string;
const parse = (text: string) => parseListing(id, JSON.parse(text));
const baseline = parse(body);

describe('listing parser', () => {
  it('reads every field from the recorded response', () => {
    expect(baseline.location).not.toBeNull();
    expect(baseline.roomType).not.toBeNull();
    expect(baseline.roomTypeText).not.toBeNull();
    expect(baseline.guestCapacity).not.toBeNull();
    expect(baseline.host?.timeAsHost).not.toBeNull();
    expect(baseline.photoUrls.length).toBeGreaterThan(0);
  });

  it('keeps a room type it does not recognise as text', () => {
    const changed = parse(body.replaceAll(`"roomType":${JSON.stringify(baseline.roomTypeText)}`, '"roomType":"Treehouse room"'));
    expect(changed.roomType).toBeNull();
    expect(changed.roomTypeText).toBe('Treehouse room');
  });

  it('reads the location subtitle and verified flag', () => {
    expect(baseline.location?.subtitle).toBe('Anchorage, Alaska, United States');
    expect(baseline.location?.verified).toBe(false);
  });

  it('fills the subtitle and verified flag on every recorded listing', () => {
    const dir = new URL('../fixtures/listings/', import.meta.url);
    const parsed: Listing[] = [];
    for (const name of readdirSync(dir)) {
      const fx = JSON.parse(gunzipSync(readFileSync(new URL(name, dir))).toString());
      const recordings = (fx.recordings as { request: { url: string }; response: { body: string } }[]).filter((r) => r.request.url.includes('/StaysPdpSections/'));
      recordings.forEach((r, i) => {
        const response = JSON.parse(r.response.body);
        if (!isMissingListing([response])) parsed.push(parseListing(fx.inputs[i] as string, response));
      });
    }
    expect(parsed.length).toBeGreaterThanOrEqual(8);
    for (const l of parsed) {
      expect(l.location?.subtitle, l.id).toMatch(/\S/);
      expect(typeof l.location?.verified, l.id).toBe('boolean');
    }
  });

  it('takes the verified flag from the location, not from the host', () => {
    const changed = parse(body.replace(/("verificationDetails":\{[^{}]*"isVerified":)false/, '$1true'));
    expect(changed.location?.verified).toBe(true);
    expect(changed.host).toEqual(baseline.host);
  });

  it('survives a renamed wrapper around the verified flag', () => {
    const changed = parse(body.replaceAll('"verificationDetails"', '"locationVerification"'));
    expect(changed.location).toEqual(baseline.location);
  });

  it('survives a renamed exact-location flag', () => {
    const changed = parse(body.replaceAll('"isExactLocation"', '"hasExactLocation"'));
    expect(changed.location).toEqual(baseline.location);
  });

  it('survives renamed wrappers around the sections', () => {
    const changed = parse(body.replaceAll('"stayProductDetailPage"', '"stayPdp"').replaceAll('"presentation"', '"viewer"'));
    expect(changed).toEqual(baseline);
  });

  it('treats a response with no listing data as something other than a listing', () => {
    expect(() => parseListing(id, { data: { presentation: null } })).toThrow(MarkerMissingError);
  });
});
