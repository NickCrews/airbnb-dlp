import type { Listing } from '../../src/types.ts';
import type { Area, Failure, FillRates, Report, Thresholds } from './contract.ts';

const share = (items: Listing[], has: (l: Listing) => boolean) => (items.length === 0 ? NaN : items.filter(has).length / items.length);

const FIELDS: Record<string, (l: Listing) => boolean> = {
  location: (l) => l.location !== null,
  roomType: (l) => l.roomType !== null,
  guestCapacity: (l) => l.guestCapacity !== null,
  host: (l) => l.host !== null,
  photoUrls: (l) => l.photoUrls.length > 0,
  beds: (l) => l.beds !== null,
  bathrooms: (l) => l.bathrooms?.count != null,
  propertyType: (l) => l.propertyType !== null,
};

export function fillRates(listings: Listing[], areas: Area[], sampled: Map<Area, string[]>): FillRates {
  const rates: FillRates = {};
  for (const [field, has] of Object.entries(FIELDS)) rates[field] = share(listings, has);
  const entire = listings.filter((l) => l.roomType === 'entire_home');
  rates['bedroomsOfEntireHomes'] = share(entire, (l) => l.bedrooms?.count != null);
  rates['exactLocation'] = share(listings.filter((l) => l.location?.exact != null), (l) => l.location!.exact === true);
  for (const area of areas) {
    const ids = new Set(sampled.get(area));
    const mine = listings.filter((l) => ids.has(l.id));
    rates[`registration.${area.id}`] = share(mine, (l) => l.registration !== null);
    rates[`bathrooms.${area.id}`] = share(mine, FIELDS['bathrooms']!);
  }
  return rates;
}

/**
 * Compares this run's fill rates with the rolling baseline: the mean of the
 * full runs in the last baselineDays. Until a day of full runs exists, the
 * starting thresholds apply instead.
 */
export function checkFillRates(rates: FillRates, history: Report[], t: Thresholds, now = Date.now()): Failure[] {
  const failures: Failure[] = [];
  const since = now - t.baselineDays * 86_400_000;
  const past = history.filter((r) => !r.small && r.fillRates && Date.parse(r.startedAt) >= since);
  const useBaseline = past.length >= 6;
  for (const [field, rate] of Object.entries(rates)) {
    if (Number.isNaN(rate)) continue;
    if (field === 'exactLocation') {
      const { min, max } = t.starting.exactLocationShare;
      if (rate < min || rate > max) failures.push({ category: 'ResponseChanged', check: `fill.${field}`, message: `exact-location share ${rate.toFixed(2)} outside ${min}-${max}` });
      continue;
    }
    let floor: number | undefined;
    if (useBaseline) {
      const values = past.map((r) => r.fillRates![field]).filter((v): v is number => typeof v === 'number' && !Number.isNaN(v));
      if (values.length > 0) floor = values.reduce((a, b) => a + b, 0) / values.length - t.baselineTolerance;
    } else if (field in t.starting.listingFields) {
      floor = t.starting.listingFields[field];
    } else if (field === 'bedroomsOfEntireHomes') {
      floor = t.starting.bedroomsOfEntireHomes;
    }
    if (floor !== undefined && rate < floor) {
      failures.push({
        category: 'ResponseChanged',
        check: `fill.${field}`,
        message: `fill rate ${rate.toFixed(2)} is below ${floor.toFixed(2)} (${useBaseline ? `${t.baselineDays}-day baseline` : 'starting threshold'})`,
      });
    }
  }
  return failures;
}
