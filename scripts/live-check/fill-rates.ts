import type { Listing } from '../../src/types.ts';
import type { Area, Failure, FillRates, Report, Thresholds } from './contract.ts';

/** Below this many listings a fill rate says too little to judge, so it is left out. */
export const MIN_SAMPLE = 5;

const share = (items: Listing[], has: (l: Listing) => boolean) =>
  items.length < MIN_SAMPLE ? NaN : items.filter(has).length / items.length;

export const OUTDOOR_TYPES = new Set(['CAMPSITE', 'TENT', 'RV']);

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
  // Campsites, tents and RVs have no bedroom line on Airbnb, so they are not counted.
  const entire = listings.filter((l) => l.roomType === 'entire_home' && !OUTDOOR_TYPES.has(l.propertyType ?? ''));
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

/** One fill-rate check: what it compared and whether it passed. A skipped check has no verdict. */
export interface FillRateCheck {
  check: string;
  outcome: 'pass' | 'fail' | 'skip';
  /** The rate and what it was compared with. On a failure, the failure's message. */
  message: string;
}

/**
 * Compares this run's fill rates with the rolling baseline: the mean of the
 * full runs in the last baselineDays. Until a day of full runs exists, the
 * starting thresholds apply instead.
 */
export function evaluateFillRates(rates: FillRates, history: Report[], t: Thresholds, now = Date.now()): FillRateCheck[] {
  const results: FillRateCheck[] = [];
  const since = now - t.baselineDays * 86_400_000;
  const past = history.filter((r) => !r.small && r.fillRates && Date.parse(r.startedAt) >= since);
  const useBaseline = past.length >= 6;
  for (const [field, rate] of Object.entries(rates)) {
    const check = `fill.${field}`;
    if (Number.isNaN(rate)) {
      results.push({ check, outcome: 'skip', message: `fewer than ${MIN_SAMPLE} listings to measure` });
      continue;
    }
    if (field === 'exactLocation') {
      const { min, max } = t.starting.exactLocationShare;
      const ok = rate >= min && rate <= max;
      results.push({ check, outcome: ok ? 'pass' : 'fail', message: `exact-location share ${rate.toFixed(2)} ${ok ? 'within' : 'outside'} ${min}-${max}` });
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
    const source = useBaseline ? `${t.baselineDays}-day baseline` : 'starting threshold';
    if (floor === undefined) {
      results.push({ check, outcome: 'skip', message: `fill rate ${rate.toFixed(2)}, recorded for the baseline; no ${source} for this field` });
    } else if (rate < floor) {
      results.push({ check, outcome: 'fail', message: `fill rate ${rate.toFixed(2)} is below ${floor.toFixed(2)} (${source})` });
    } else {
      results.push({ check, outcome: 'pass', message: `fill rate ${rate.toFixed(2)} is at least ${floor.toFixed(2)} (${source})` });
    }
  }
  return results;
}

export function checkFillRates(rates: FillRates, history: Report[], t: Thresholds, now = Date.now()): Failure[] {
  return evaluateFillRates(rates, history, t, now)
    .filter((r) => r.outcome === 'fail')
    .map((r) => ({ category: 'ResponseChanged', check: r.check, message: r.message }));
}
