/**
 * Fields the library maps from Airbnb's text onto a closed set. A value Airbnb
 * sends that the mapping does not recognise becomes null, which a consumer
 * cannot tell from a missing value, so any such value fails the check. The
 * failure message gives field and count; the values themselves go in detail.
 */
import type { Listing } from '../../src/types.ts';
import type { Failure, Thresholds } from './contract.ts';

/** For each field, Airbnb's text when the listing has one the mapping left unrecognised. */
const CLOSED_SETS: Record<string, (l: Listing) => string | null> = {
  roomType: (l) => (l.roomTypeText !== null && l.roomType === null ? l.roomTypeText : null),
  bedrooms: (l) => (l.bedrooms !== null && l.bedrooms.count === null ? l.bedrooms.text : null),
  bathrooms: (l) => (l.bathrooms !== null && l.bathrooms.count === null && l.bathrooms.access === null ? l.bathrooms.text : null),
};

export function checkClosedSets(listings: Listing[], t: Thresholds): Failure[] {
  const failures: Failure[] = [];
  for (const [field, unrecognised] of Object.entries(CLOSED_SETS)) {
    const counts = new Map<string, number>();
    for (const l of listings) {
      const text = unrecognised(l);
      if (text !== null) counts.set(text, (counts.get(text) ?? 0) + 1);
    }
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    if (total <= t.maxUnrecognisedValues) continue;
    failures.push({
      category: 'ResponseChanged',
      check: `values.${field}`,
      message: `${total} of ${listings.length} listings have a ${field} value the library does not recognise (${counts.size} distinct)`,
      detail: [...counts].map(([text, n]) => `${JSON.stringify(text)} x${n}`).join(', '),
    });
  }
  return failures;
}
